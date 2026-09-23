import type { Args } from '../args.ts';
import { serveStdio } from '../mcp/server.ts';

/**
 * `actario mcp` -- serve the capture front door over stdio until the client
 * disconnects. See mcp/server.ts for what it is and, more importantly, what
 * it is not (the read-only reflow MCP of arch §12 / appendix D).
 *
 * The process stays alive as long as stdin is open; exit code is whatever
 * the transport ends with. Nothing is printed to stdout by this file --
 * stdout is the wire.
 */
export async function mcpCommand(_args: Args): Promise<number> {
  await serveStdio();
  // The transport resolves connect() immediately and keeps the process alive
  // through its stdin listener; returning here would let main() exit. Hold.
  await new Promise<void>((resolve) => {
    process.stdin.on('end', () => resolve());
    process.stdin.on('close', () => resolve());
  });
  return 0;
}
