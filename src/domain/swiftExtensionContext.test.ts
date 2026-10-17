import { describe, expect, it } from "vitest";
import { classifySwiftSymbol } from "./swiftSymbolClassification.js";

describe("bounded substituted extension contexts", () => {
  it.each([
    "AAE",
    "ABE",
    "AASQRzlE",
    "AASHRzlE",
    "AASiRszlE",
    "AA5Other1CVRszlE",
    "AA5Other1CCRbzlE",
    "AA5Other1OV1CVRszlE",
    "AASQR_rlE",
    "AASQR0_r0_lE",
    "AASQRd__r_zlE",
    "AARi_zrlE",
    "AARi0_d0_1_r0_1_lE",
    "A2A1PRzlE",
    "AaA1PRzlE",
    "AAAB1PRzlE",
    "AA5Other1PRzlE",
    "AASQRzSQR_rlE",
  ])("stops carrying nominal evidence at %s", (tail) => {
    expect(classifySwiftSymbol(`$s1M1WV${tail}1fyyF`)).toEqual({
      category: null,
    });
  });

  it.each([
    // Missing/malformed indexes and signature terminators.
    "AASQRlE",
    "AASQR0lE",
    "AASQRd_lE",
    "AASQRd0_ElE",
    "AASQR99999999999999999999_lE",
    "AASQR2147483647_lE",
    "AASQRzE",
    "AASQRzr0_E",
    "AARizrlE",
    "AARi_zrEl",
    "AASQRzr99999999999999999999_lE",
    // Unsupported generic requirements cannot establish nominal ownership.
    "AASQRpzlE",
    "AARvzlE",
    "AASERzlE",
    "AASLRzlE",
    "AAScARzlE",
    "AASiRtunknownE",
    "AASQRzunknownE",
    "AAS?E",
  ])("keeps generic context uncertainty for %s", (tail) => {
    expect(classifySwiftSymbol(`$s1M1WV${tail}1fyyF`)).toEqual({
      category: null,
    });
  });

  it.each([
    "$s1M1WVAASivg",
    "$s1M1WVABSivg",
    "$s1M1WVAASiyF",
    "$s1M1WVAA5Other1CVvg",
  ])("retains nominal ownership for substituted member name %s", (name) => {
    expect(classifySwiftSymbol(name)).toEqual({ category: "structs" });
  });

  it.each([
    // E must be an operator at the exact context boundary, not identifier text.
    "AA1E",
    "AA5Other1ERzl",
    "AA5Other2PERzl",
    "AA5Other99PRzlE",
    "AA5Other01PRzlE",
    "AA5Other99999999999999999999PRzlE",
    // Pending groups, nominal/out-of-inventory references, unsafe counts.
    "A2AE",
    "AaE",
    "A3A1PRzlE",
    "AaC1PRzlE",
    "ACE",
    "AZE",
    "A_E",
    "A99999999999999999999A1PRzlE",
    "A0A1PRzlE",
    "AA5Other1PRzl1EE",
    "AA5Other1PRzlTW",
    "AAunknownE",
  ])(
    "retains baseline nominal classification for unsupported tail %s",
    (tail) => {
      expect(classifySwiftSymbol(`$s1M1WV${tail}1fyyF`)).toEqual({
        category: "structs",
      });
    },
  );
});
