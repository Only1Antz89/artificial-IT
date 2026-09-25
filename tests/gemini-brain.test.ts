import { describe, expect, it, vi } from "vitest";
import { GeminiBrain } from "../src/agent/gemini-brain.js";
import { Ticket } from "../src/contracts/index.js";

const ticket = Ticket.parse({
  id: "ticket-1",
  source: "manual",
  subject: "Cannot reach the printer",
  description: "The office printer has shown offline since this morning.",
  requester: { id: "user-1", name: "Test User" },
  created_at: "2026-09-25T10:00:00.000Z",
  updated_at: "2026-09-25T10:00:00.000Z",
});

describe("Gemini brain", () => {
  it("requests JSON Schema output and validates the result", async () => {
    const generateContent = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        summary: "Printer appears offline.",
        category: "printing",
        reported_symptoms: ["printer offline"],
        missing_information: [],
        out_of_scope: false,
        user_sentiment: "blocked",
      }),
    });
    const brain = new GeminiBrain({
      client: { models: { generateContent } } as never,
      model: "gemini-test",
    });

    const intake = await brain.intake({ ticket });
    expect(intake.category).toBe("printing");
    expect(generateContent).toHaveBeenCalledOnce();
    const request = generateContent.mock.calls[0]![0];
    expect(request.model).toBe("gemini-test");
    expect(request.config.responseMimeType).toBe("application/json");
    expect(request.config.responseJsonSchema.type).toBe("object");
    expect(request.config.responseJsonSchema.$schema).toBeUndefined();
  });

  it("rejects malformed structured output", async () => {
    const brain = new GeminiBrain({
      client: {
        models: { generateContent: vi.fn().mockResolvedValue({ text: "not-json" }) },
      } as never,
    });
    await expect(brain.intake({ ticket })).rejects.toThrow(/invalid JSON/);
  });
});
