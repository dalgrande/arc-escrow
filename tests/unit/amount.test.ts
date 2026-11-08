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

import { describe, expect, it } from "vitest";
import { convertUSDCToContractAmount, parseAmount } from "@/lib/utils/amount";

describe("parseAmount", () => {
  it("accepts plain and formatted decimal amounts", () => {
    expect(parseAmount("10")).toBe(10);
    expect(parseAmount("$1,250.50")).toBe(1250.5);
    expect(parseAmount("(42.01)")).toBe(42.01);
  });

  it("accepts amounts labelled with a currency code", () => {
    expect(parseAmount("500 USDC")).toBe(500);
    expect(parseAmount("USD 1,500")).toBe(1500);
    expect(parseAmount("1,500.00 usd")).toBe(1500);
  });

  it.each(["10abc", "1e5", "0x10", "Infinity", "1.2.3", ".5", "5.", "", "0.0000004", "1.0000005", "USDC"])(
    "rejects the malformed amount %j instead of reading a numeric prefix",
    (input) => {
      expect(() => parseAmount(input)).toThrow(/Invalid amount/);
    }
  );

  it("rejects zero and negative amounts", () => {
    expect(() => parseAmount("0")).toThrow(/Invalid amount/);
    expect(() => parseAmount("-5")).toThrow(/Invalid amount/);
    expect(() => parseAmount("−5")).toThrow(/Invalid amount/);
  });
});

describe("convertUSDCToContractAmount", () => {
  it("returns whole USDC base units even when float math lands just below", () => {
    // 2.01 * 1_000_000 is 2009999.9999999998 in IEEE-754.
    expect(convertUSDCToContractAmount(2.01)).toBe("2010000");
    expect(convertUSDCToContractAmount(0.29)).toBe("290000");
    expect(convertUSDCToContractAmount(1250.5)).toBe("1250500000");
  });
});
