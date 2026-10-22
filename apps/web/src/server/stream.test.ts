import { describe, expect, it } from "vitest";
import { primedTextStream } from "./stream";

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("primedTextStream", () => {
  it("streams every non-empty chunk in order", async () => {
    async function* gen() {
      yield "a";
      yield "";
      yield "b";
      yield "c";
    }
    expect(await readAll(await primedTextStream(gen()))).toBe("abc");
  });

  it("rejects up front when the first chunk fails (so the route can answer JSON)", async () => {
    // eslint-disable-next-line require-yield
    async function* gen(): AsyncGenerator<string, void, undefined> {
      throw new Error("bad where");
    }
    await expect(primedTextStream(gen())).rejects.toThrow("bad where");
  });

  it("errors the stream when a later chunk fails", async () => {
    async function* gen() {
      yield "header";
      throw new Error("boom");
    }
    const stream = await primedTextStream(gen());
    await expect(readAll(stream)).rejects.toThrow("boom");
  });

  it("closes the generator when the download is cancelled", async () => {
    let closed = false;
    async function* gen() {
      try {
        for (let i = 0; ; i++) yield `row${i}\n`;
      } finally {
        closed = true;
      }
    }
    const stream = await primedTextStream(gen());
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    expect(closed).toBe(true);
  });
});
