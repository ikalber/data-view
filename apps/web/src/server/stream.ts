/**
 * Turn an async generator of text chunks into a pull-based byte stream for a
 * download response.
 *
 * The first chunk is produced *before* the stream is returned, so failures
 * that happen early (bad WHERE filter, missing table, connection refused)
 * reject this promise and the route can answer with a normal JSON error
 * instead of an aborted download. Pulling one chunk at a time gives
 * backpressure, and cancelling the download closes the generator so the
 * driver releases its connection.
 */
export async function primedTextStream(
  gen: AsyncGenerator<string, void, undefined>,
): Promise<ReadableStream<Uint8Array>> {
  const encoder = new TextEncoder();
  let pending: IteratorResult<string, void> | null = await gen.next();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Skip empty chunks so every pull either enqueues data or closes.
        for (;;) {
          const next = pending ?? (await gen.next());
          pending = null;
          if (next.done) {
            controller.close();
            return;
          }
          if (next.value) {
            controller.enqueue(encoder.encode(next.value));
            return;
          }
        }
      } catch (e) {
        // Headers are already sent; erroring the stream makes the client's
        // download fail instead of silently saving a truncated file.
        controller.error(e);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}
