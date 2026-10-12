# Sharesight MCP Server

A Model Context Protocol (MCP) server that gives AI assistants read-only access to [Sharesight](https://www.sharesight.com/) portfolio performance data.

This allows an AI agent to list your portfolios and retrieve a full performance breakdown — including all holdings and their individual performance — for any portfolio over any date range.

## Quick Start

### Step 1: Get OAuth Credentials

You'll need a **Client ID** and **Client Secret** from Sharesight.

- Contact Sharesight support at support@sharesight.com to request API access
- Visit the [Sharesight API documentation](https://api.sharesight.com/doc/api/v3) for more information
- API access may require a specific Sharesight plan

### Step 2: Add MCP Server Configuration

Add to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "sharesight": {
      "command": "npx",
      "args": ["-y", "github:robdevops/sharesight-mcp"],
      "env": {
        "SHARESIGHT_CLIENT_ID": "your_client_id",
        "SHARESIGHT_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

Restart Claude Desktop and you're ready to go.

## What can it do?

Ask Claude things like:

- *"How has my portfolio performed this year?"*
- *"Which of my holdings has performed best over the last 6 months?"*
- *"Show me my portfolio performance for the 2026 financial year."*
- *"What are my biggest positions and how are they tracking?"*

## Tools

| Tool | Description |
|------|-------------|
| `list_portfolios` | List all portfolios in the account |
| `get_performance_report` | Get a full performance breakdown for a portfolio, including all holdings and their gains, over a specified date range |

## Streamable HTTP mode

By default the server speaks MCP over stdio. It can also run as a Streamable HTTP server, for clients that connect to a URL rather than launching a process.

Build from source (see [Install from Source](#install-from-source)), then start it:

```bash
SHARESIGHT_CLIENT_ID=... SHARESIGHT_CLIENT_SECRET=... \
  node dist/index.js --http [--host 127.0.0.1] [--port 8932]
```

You must start the server yourself before a client can connect; a `url` entry in a client config does not launch anything.

> `npx -y github:robdevops/sharesight-mcp --http` also works, but the first run clones, installs and builds (about a minute or more), and `npx` caches git packages, so you may keep getting a stale build. Running from a source checkout avoids both.

The endpoint is `http://127.0.0.1:8932/mcp`. Options:

| Flag | Default | Description |
|------|---------|-------------|
| `--http` | off | Serve Streamable HTTP instead of stdio |
| `--host` | `127.0.0.1` | Interface to bind to |
| `--port` | `8932` | Port to listen on |

Then point an MCP client that supports Streamable HTTP at the URL in its `mcp_servers.json` (or equivalent). The credentials stay with the server process, so the client entry needs only the URL:

```json
{
  "mcpServers": {
    "sharesight": {
      "url": "http://127.0.0.1:8932/mcp"
    }
  }
}
```

The HTTP server is stateless (no sessions): each `POST /mcp` is handled independently, and other methods return `405`.

> **Security warning:** the HTTP endpoint has **no authentication** and no `Origin`/`Host` validation, and every request is served using your Sharesight credentials. Anyone who can reach the port can read your portfolio data. Keep the default loopback binding, and do not use `--host 0.0.0.0` (or expose the port) unless you put it behind an authenticating reverse proxy or a firewall. Browsers can also reach localhost services via DNS rebinding, so only run it when you need it.

### Run on boot (systemd)

On Linux, run the server as a systemd user service. These steps assume the repo is built at `~/sharesight-mcp`.

1. Store the credentials in a private file (not in the unit file):

   ```bash
   mkdir -p ~/.config/sharesight-mcp
   printf 'SHARESIGHT_CLIENT_ID=your_client_id\nSHARESIGHT_CLIENT_SECRET=your_client_secret\n' \
     > ~/.config/sharesight-mcp/env
   chmod 600 ~/.config/sharesight-mcp/env
   ```

2. Create `~/.config/systemd/user/sharesight-mcp.service`:

   ```ini
   [Unit]
   Description=Sharesight MCP server (HTTP)
   After=network-online.target

   [Service]
   EnvironmentFile=%h/.config/sharesight-mcp/env
   ExecStart=/usr/bin/env node %h/sharesight-mcp/dist/index.js --http --host 127.0.0.1 --port 8932
   Restart=on-failure

   [Install]
   WantedBy=default.target
   ```

   If `node` is installed via nvm or similar, replace `/usr/bin/env node` with the absolute path from `which node`.

3. Enable and start it, and allow it to start at boot without an active login:

   ```bash
   systemctl --user daemon-reload
   systemctl --user enable --now sharesight-mcp
   loginctl enable-linger "$USER"
   ```

Check it with `systemctl --user status sharesight-mcp` and `journalctl --user -u sharesight-mcp -f`. After updating the code (`git pull && npm install && npm run build`), restart it with `systemctl --user restart sharesight-mcp`.

An always-on server widens the exposure described in the warning below, so keep it bound to `127.0.0.1`.

## Authentication

This server uses the OAuth 2.0 **client credentials** grant type. Your `SHARESIGHT_CLIENT_ID` and `SHARESIGHT_CLIENT_SECRET` are passed as environment variables — no browser-based auth flow or stored token files required. Tokens are fetched automatically and refreshed in memory when they expire.

## Install from Source

```bash
git clone https://github.com/robdevops/sharesight-mcp.git
cd sharesight-mcp
npm install
npm run build
```

Then configure Claude Desktop to use the local build:

```json
{
  "mcpServers": {
    "sharesight": {
      "command": "node",
      "args": ["/path/to/sharesight-mcp/dist/index.js"],
      "env": {
        "SHARESIGHT_CLIENT_ID": "your_client_id",
        "SHARESIGHT_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

## Development

```bash
npm run dev     # Watch mode
npm run build   # Build for production
npm start       # Run the server
```

## License

MIT — see [LICENSE](LICENSE). Original work by [Haizzz](https://github.com/Haizzz/sharesight-mcp), forked and extended by [sryburn](https://github.com/sryburn/sharesight-mcp).

## Credits & Fork Notes

This project is a fork of [sryburn/sharesight-mcp](https://github.com/sryburn/sharesight-mcp), which is itself a fork of [Haizzz/sharesight-mcp](https://github.com/Haizzz/sharesight-mcp). Thanks to both authors.

**[Haizzz/sharesight-mcp](https://github.com/Haizzz/sharesight-mcp)** — the original MCP server for the Sharesight API.

**[sryburn/sharesight-mcp](https://github.com/sryburn/sharesight-mcp)** — changes from the original:

- Stripped down to two read-only tools (`list_portfolios`, `get_performance_report`) covering the core portfolio performance use case
- Switched from OAuth 2.0 authorization code flow to **client credentials** grant type, eliminating the need for a one-time browser-based auth setup and stored token files
- Credentials are passed via environment variables only; no state is written to disk

**[robdevops/sharesight-mcp](https://github.com/robdevops/sharesight-mcp)** (this repository) — changes from sryburn's fork:

- Added a stateless Streamable HTTP mode (`--http`)
- Concurrent requests share a single in-flight token fetch
- Dependency security updates

## Support

- **Sharesight Support**: support@sharesight.com
- **API Documentation**: https://api.sharesight.com/doc/api/v3
- **MCP Protocol**: https://modelcontextprotocol.io/
