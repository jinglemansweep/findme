import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { sendRecoveryEmail } from "../src/email/send";

const e = env as unknown as Env;

interface SentMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

function fakeEmailBinding(sent: SentMessage[]): SendEmail {
  return { send: async (message: SentMessage) => void sent.push(message) } as unknown as SendEmail;
}

describe("recovery email", () => {
  it("sends a template-only message from the verified sender", async () => {
    const sent: SentMessage[] = [];
    const rawTo = `  Sent-${crypto.randomUUID()}@Example.COM  `;
    const link = "http://localhost/u/0123456789AB#s_secret";

    const result = await sendRecoveryEmail({ ...e, EMAIL: fakeEmailBinding(sent) }, rawTo, link, Date.now() + 3_600_000);

    expect(result).toBe("sent");
    expect(sent).toHaveLength(1);
    // The sender must match allowed_sender_addresses in every wrangler env.
    expect(sent[0].from).toBe("noreply@find.appts.uk");
    expect(sent[0].to).toBe(rawTo.trim().toLowerCase());
    expect(sent[0].text).toContain(link);
    // Pure template: no markup and no channel for user-controlled content.
    expect(sent[0].text).not.toContain("<");
  });

  it("skips without a binding or with an invalid address", async () => {
    expect(await sendRecoveryEmail({ ...e, EMAIL: undefined }, "a@b.co", "u", 0)).toBe("skipped");
    const sent: SentMessage[] = [];
    expect(await sendRecoveryEmail({ ...e, EMAIL: fakeEmailBinding(sent) }, "not an address", "u", 0)).toBe("skipped");
    expect(sent).toHaveLength(0);
  });

  it("rate-limits the fourth send to one recipient per day", async () => {
    const sent: SentMessage[] = [];
    const envWithMail = { ...e, EMAIL: fakeEmailBinding(sent) };
    const to = `rl-${crypto.randomUUID()}@example.com`;
    const link = "http://localhost/u/0123456789AB#s_secret";

    expect(await sendRecoveryEmail(envWithMail, to, link, 0)).toBe("sent");
    expect(await sendRecoveryEmail(envWithMail, to, link, 0)).toBe("sent");
    expect(await sendRecoveryEmail(envWithMail, to, link, 0)).toBe("sent");
    expect(await sendRecoveryEmail(envWithMail, to, link, 0)).toBe("rate-limited");
    expect(sent).toHaveLength(3);
  });
});
