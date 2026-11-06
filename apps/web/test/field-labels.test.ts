import { describe, expect, it } from "vitest";
import { fieldLabel, fieldList } from "../src/app/field-labels";

describe("plain-English field labels for approval warnings", () => {
  it("maps known action fields to words people use", () => {
    expect(fieldLabel("customerEmail")).toBe("customer's email");
    expect(fieldLabel("to")).toBe("recipient address");
    expect(fieldLabel("amountCents")).toBe("amount");
  });
  it("never shows camelCase, snake_case or digits glued to words for unknown fields", () => {
    expect(fieldLabel("billingAddress_line1")).toBe("billing address line 1");
    expect(fieldLabel("vendorTaxId")).toBe("vendor tax id");
    for (const k of ["customerEmail", "customerName", "notes", "someNewField", "x_y"]) expect(fieldLabel(k)).not.toMatch(/[A-Z_]/);
  });
  it("joins as a readable sentence fragment, without duplicates", () => {
    expect(fieldList(["customerEmail", "customerName", "notes"])).toBe("the customer's email, the customer's name and the notes");
    expect(fieldList(["to"])).toBe("the recipient address");
    expect(fieldList(["body", "text"])).toBe("the message text");
    expect(fieldList([])).toBe("");
  });
});
