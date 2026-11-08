/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin-client";
import { getUsdcBalance } from "@/lib/circle/wallet-data";

async function updateAgreementTransaction(transactionId: string, notification: Record<string, unknown>) {
  const supabase = createSupabaseAdminClient();

  const { data: transactionToUpdate, error: transactionError } = await supabase
    .from("transactions")
    .select()
    .eq("circle_transaction_id", transactionId)
    .single();

  if (transactionError || transactionToUpdate.status === notification.state) return;

  await supabase
    .from("transactions")
    .update({
      status: notification.state,
      circle_contract_address: notification.contractAddress
    })
    .eq("circle_transaction_id", transactionId);

  const { data: agreement, error: agreementError } = await supabase
    .from("escrow_agreements")
    .select()
    .eq(
      transactionToUpdate.escrow_agreement_id ? "id" : "transaction_id",
      transactionToUpdate.escrow_agreement_id || transactionToUpdate.id
    )
    .single();

  if (agreementError) {
    console.error("Could not find an escrow agreement with the given transaction id", agreementError);
    return;
  }

  if (transactionToUpdate.transaction_type === "DEPLOY_CONTRACT") {
    if (notification.state === "COMPLETE") {
      await supabase
        .from("escrow_agreements")
        .update({ status: "OPEN" })
        .eq("id", agreement.id);

      return;
    }

    if (agreement.status === "PENDING") return;

    await supabase
      .from("escrow_agreements")
      .update({ status: "PENDING" })
      .eq("id", agreement.id);

    return
  }

  if (transactionToUpdate.transaction_type === "DEPOSIT_APPROVAL" && notification.state === "FAILED") {
    await supabase
      .from("escrow_agreements")
      .update({ status: "OPEN" })
      .eq("id", agreement.id);

    return;
  }

  if (transactionToUpdate.transaction_type === "DEPOSIT_REFUND") {
    if (notification.state === "FAILED") {
      // A refund can only be requested while the funds are locked, and a failed one
      // leaves them locked. Sending it back to OPEN would invite a second deposit.
      await supabase
        .from("escrow_agreements")
        .update({ status: "LOCKED" })
        .eq("id", agreement.id);
    }

    if (notification.state !== "COMPLETE") return;

    await supabase
      .from("escrow_agreements")
      .delete()
      .eq("id", agreement.id);
  }

  if (transactionToUpdate.transaction_type === "DEPOSIT_PAYMENT") {
    if (notification.state === "FAILED") {
      await supabase
        .from("escrow_agreements")
        .update({ status: "OPEN" })
        .eq("id", agreement.id);
    }

    if (notification.state !== "COMPLETE") return;

    await supabase
      .from("escrow_agreements")
      .update({ status: "LOCKED" })
      .eq("id", agreement.id);

    return;
  }

  if (transactionToUpdate.transaction_type === "RELEASE_PAYMENT") {
    if (notification.state === "FAILED") {
      await supabase
        .from("escrow_agreements")
        .update({ status: "LOCKED" })
        .eq("id", agreement.id);
    }

    if (notification.state !== "COMPLETE") return;

    await supabase
      .from("escrow_agreements")
      .update({ status: "CLOSED" })
      .eq("id", agreement.id);
  }
}

export async function POST(req: NextRequest) {
  try {
    const supabase = createSupabaseAdminClient();
    const signature = req.headers.get("x-circle-signature");
    const keyId = req.headers.get("x-circle-key-id");

    if (!signature || !keyId) {
      return NextResponse.json(
        { error: "Missing signature or keyId in headers" },
        { status: 400 }
      );
    }

    // Circle key ids are UUIDs; anything else never reaches the outbound key lookup.
    if (!KEY_ID_PATTERN.test(keyId)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    let publicKey: crypto.KeyObject;
    try {
      publicKey = await getCirclePublicKey(keyId);
    } catch (error) {
      // Our failure to fetch the key, not a bad signature: answer retryably so Circle redelivers.
      console.error("Could not load Circle public key:", error);
      return NextResponse.json(
        { error: "Signature key temporarily unavailable" },
        { status: 503 }
      );
    }

    // Circle signs the exact bytes it sent, so verify those, not a re-serialization.
    const rawBody = await req.text();

    if (!verifyCircleSignature(rawBody, signature, publicKey)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 403 });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    console.log("Received notification:", body);

    const {
      id: transactionId,
      walletId,
      state: transactionState
    } = body.notification;

    if (walletId && transactionState === "COMPLETE") {
      // Read the balance directly (a fetch to our own API would carry no session).
      // A balance we cannot read must not stop the status update below.
      try {
        const balance = await getUsdcBalance(walletId);

        await supabase
          .from("wallets")
          .update({ balance })
          .eq("circle_wallet_id", walletId);
      } catch (balanceError) {
        console.error(`Could not refresh the balance of wallet ${walletId}:`, balanceError);
      }
    }

    await updateAgreementTransaction(transactionId, body.notification);

    return NextResponse.json({ received: true }, { status: 200 });
  } catch (error) {
    console.error("Failed to process notification:", error);
    return NextResponse.json(
      { error: "Failed to process notification" },
      { status: 500 }
    );
  }
}

export async function HEAD() {
  return NextResponse.json({}, { status: 200 });
}

function verifyCircleSignature(
  bodyString: string,
  signature: string,
  publicKey: crypto.KeyObject
): boolean {
  try {
    const verifier = crypto.createVerify("SHA256");
    verifier.update(bodyString);
    verifier.end();

    const signatureUint8Array = Uint8Array.from(Buffer.from(signature, "base64"));
    return verifier.verify(publicKey, signatureUint8Array);
  } catch (error) {
    console.error("Signature verification error:", error);
    return false;
  }
}

const KEY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A key id always maps to the same public key (per Circle's docs), so cache for the process lifetime.
// Caching the in-flight promise makes concurrent cold requests share one fetch.
const publicKeyCache = new Map<string, Promise<crypto.KeyObject>>();

function getCirclePublicKey(keyId: string): Promise<crypto.KeyObject> {
  const cacheKey = keyId.toLowerCase();
  const cached = publicKeyCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const lookup = fetchCirclePublicKey(cacheKey);
  publicKeyCache.set(cacheKey, lookup);
  // A failed lookup must not stick: drop it so the next delivery retries.
  lookup.catch(() => publicKeyCache.delete(cacheKey));
  return lookup;
}

async function fetchCirclePublicKey(keyId: string): Promise<crypto.KeyObject> {
  if (!process.env.CIRCLE_API_KEY) {
    throw new Error("Circle API key is not set");
  }

  const response = await fetch(`https://api.circle.com/v2/notifications/publicKey/${keyId}`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${process.env.CIRCLE_API_KEY}`
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch public key: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const rawPublicKey = data?.data?.publicKey;
  if (typeof rawPublicKey !== "string" || rawPublicKey.length === 0) {
    throw new Error("Malformed public key response from Circle");
  }

  // Throws on anything that is not a valid DER public key, so a bad response is never cached.
  return crypto.createPublicKey({
    key: Buffer.from(rawPublicKey, "base64"),
    format: "der",
    type: "spki",
  });
}
