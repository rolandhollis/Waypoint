import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createWaypointMcpServer, type McpAuthContext } from "./waypointMcp.js";

/**
 * Stateless Streamable HTTP MCP handler. One McpServer + transport
 * per request (Claude's remote connector pattern). Caller must run
 * authenticate + groupScope first so req.user / req.groupId are set.
 */
export async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const ctx = authContextFromRequest(req);
  if (!ctx) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Authentication required" },
      id: null,
    });
    return;
  }

  const server = createWaypointMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({
    // Stateless — no server-side session map. Claude reconnects
    // freely; each tools/call carries the same API token header.
    sessionIdGenerator: undefined,
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request failed", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  } finally {
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  }
}

export function handleMcpMethodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST." },
    id: null,
  });
}

function authContextFromRequest(req: Request): McpAuthContext | null {
  if (!req.user || !req.groupId || !req.userGroupRole) return null;
  return {
    userId: req.user.id,
    userName: req.user.name,
    userEmail: req.user.email,
    groupId: req.groupId,
    role: req.userGroupRole,
    isAdmin: req.userGroupRole === "admin" || req.user.is_super_user,
  };
}
