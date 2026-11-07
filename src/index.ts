#!/usr/bin/env node

/**
 * Sharesight MCP Server
 *
 * @see https://api.sharesight.com/doc/api/v3
 * @see https://modelcontextprotocol.io/
 *
 * @module index
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import { SharesightClient } from "./sharesight-client.js";
import { OAuthManager } from "./oauth.js";

function formatResult(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function formatError(error: unknown) {
  const errorMessage = error instanceof Error ? error.message : String(error);

  return { content: [{ type: "text" as const, text: `Error: ${errorMessage}` }], isError: true };
}

function registerTools(server: McpServer, client: SharesightClient) {
  server.registerTool(
    "list_portfolios",
    {
      description: "Retrieves a list of the user's portfolios. Optionally filter by consolidated view or instrument.",
      inputSchema: z.object({
        consolidated: z.boolean().optional().describe("Set to true to see consolidated portfolio views"),
        instrument_id: z.number().optional().describe("Filter by instrument ID. When set, consolidated defaults to false"),
      }),
    },
    async (args) => {
      try {
        const result = await client.listPortfolios(args);

        return formatResult(result);
      } catch (error) {
        return formatError(error);
      }
    }
  );

  server.registerTool(
    "get_performance_report",
    {
      description: "Retrieves the performance report for a portfolio with gains, holdings breakdown, and benchmarks",
      inputSchema: z.object({
        portfolio_id: z.number().describe("The portfolio ID"),
        start_date: z.string().optional().describe("Start date YYYY-MM-DD (defaults to portfolio inception)"),
        end_date: z.string().optional().describe("End date YYYY-MM-DD (defaults to today)"),
        consolidated: z.boolean().optional().describe("Set to true for consolidated portfolio views"),
        include_sales: z.boolean().optional().describe("Include or exclude sales"),
        report_combined: z.boolean().optional().describe("Receive combined totals for same instruments across portfolios"),
        grouping: z.string().optional().describe("Group by: country, currency, custom_group, industry_classification, investment_type, market, portfolio, sector_classification, ungrouped"),
        custom_group_id: z.number().optional().describe("Custom group ID (requires grouping=custom_group)"),
        include_limited: z.boolean().optional().describe("Include holdings limited by user plan"),
        benchmark_code: z.string().optional().describe("Benchmark code and market (e.g., SPY.NYSE)"),
      }),
    },
    async (args) => {
      try {
        const result = await client.getPerformanceReport(args.portfolio_id, {
          start_date: args.start_date,
          end_date: args.end_date,
          consolidated: args.consolidated,
          include_sales: args.include_sales,
          report_combined: args.report_combined,
          grouping: args.grouping,
          custom_group_id: args.custom_group_id,
          include_limited: args.include_limited,
          benchmark_code: args.benchmark_code,
        });

        return formatResult(result);
      } catch (error) {
        return formatError(error);
      }
    }
  );
}

function createMcpServer(client: SharesightClient): McpServer {
  const server = new McpServer({
    name: "sharesight-mcp",
    version: "1.0.0",
  });

  registerTools(server, client);
  return server;
}

function getOption(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback;
}

function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

// Hashing both sides gives equal-length buffers, so the comparison is constant-time
// and does not leak the token's length.
function isAuthorized(req: IncomingMessage, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  return match !== null && timingSafeEqual(sha256(match[1].trim()), sha256(token));
}

async function runStdio(client: SharesightClient): Promise<void> {
  const server = createMcpServer(client);
  await server.connect(new StdioServerTransport());
  console.error("Sharesight MCP server running on stdio");
}

function runHttp(
  client: SharesightClient,
  host: string,
  port: number,
  token: string | undefined
): void {
  const httpServer = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;

    if (pathname !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }

    if (token && !isAuthorized(req, token)) {
      res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end("Unauthorized");
      return;
    }

    // Stateless mode: only POST is supported.
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end("Method not allowed");
      return;
    }

    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP request failed:", error);

      if (!res.headersSent) {
        res.writeHead(500).end("Internal server error");
      }
    }
  });

  httpServer.on("error", (error) => {
    console.error("HTTP server error:", error);
    process.exit(1);
  });

  const shutdown = () => {
    httpServer.close(() => process.exit(0));
    httpServer.closeAllConnections();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  httpServer.listen(port, host, () => {
    console.error(`Sharesight MCP server listening on http://${host}:${port}/mcp`);
    console.error(
      token
        ? "Bearer token authentication enabled"
        : "WARNING: no SHARESIGHT_MCP_TOKEN set; the HTTP endpoint is unauthenticated"
    );
  });
}

async function main(): Promise<void> {
  const clientId = process.env.SHARESIGHT_CLIENT_ID;
  const clientSecret = process.env.SHARESIGHT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error(
      "Error: Missing credentials. Set SHARESIGHT_CLIENT_ID and SHARESIGHT_CLIENT_SECRET environment variables."
    );
    process.exit(1);
  }

  const oauth = new OAuthManager({ clientId, clientSecret });
  const client = new SharesightClient(oauth);

  const args = process.argv.slice(2);

  if (!args.includes("--http")) {
    await runStdio(client);
    return;
  }

  const host = getOption(args, "--host", "127.0.0.1");
  const port = Number(getOption(args, "--port", "8932"));

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${getOption(args, "--port", "8932")}`);
  }

  const token = process.env.SHARESIGHT_MCP_TOKEN?.trim() || undefined;

  if (!token && !isLoopbackHost(host) && !args.includes("--unsafe-no-token")) {
    throw new Error(
      `Refusing to bind to non-local host ${host} without authentication. ` +
        "Set SHARESIGHT_MCP_TOKEN, or pass --unsafe-no-token to override."
    );
  }

  runHttp(client, host, port, token);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
