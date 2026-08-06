# Blender MCP — setup & use

[ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) lets an agent drive a **live Blender** session (create/edit objects, materials, run `bpy` code, pull Poly Haven / Sketchfab assets).

**Gauntlet Loop is a game skill.** Use Blender when the **game** needs real 3D meshes (weapons, props, kits, GLB/FBX) — not for 2D sprites (use image gen) and not as a capture farm inside the game engine.

When to pick Blender vs image gen: [ASSETS.md](ASSETS.md).

← [SKILL.md](SKILL.md) · [ASSETS.md](ASSETS.md)

> **Status on this machine (checked 2026-08-06): none of this is installed yet.**
> No Blender, no `uv`/`uvx`, no Homebrew. Everything below is setup you must
> do first — it is not ready to use. Do not assume Blender tools are available.

## Architecture (two pieces)

1. **Blender addon** — socket server inside Blender (default `localhost:9876`)
2. **MCP server** — `uvx blender-mcp`, started by Claude Code / Cursor / Claude Desktop

The client must **not** run `uvx blender-mcp` in a random terminal while the IDE also starts it. One MCP instance only.

## Prerequisites

- Blender 3.0+ — **not installed here.** Get it from [blender.org](https://www.blender.org/download/)
- Python 3.10+ for the MCP side (pin **3.11** via uv-managed).
  System python here is 3.9.6, which is too old — uv supplies its own, so this is fine
- [`uv`](https://docs.astral.sh/uv/) / `uvx` — **not installed here.** Homebrew is also absent,
  so `brew install uv` will not work. Use the standalone installer from
  [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/) instead
- Use the **full path** to `uvx` in GUI clients (`/opt/homebrew/bin/uvx`) so Dock-launched apps find it

## Setup

### 1. Install the Blender addon

1. Download [`addon.py`](https://raw.githubusercontent.com/ahujasid/blender-mcp/main/addon.py) from the repo
2. Blender → **Edit → Preferences → Add-ons → Install…** → select the file  
   (or place it as `~/Library/Application Support/Blender/<version>/scripts/addons/blender_mcp.py` and enable **Interface: Blender MCP**)
3. Enable the checkbox for **Interface: Blender MCP**

(The upstream repo claimed the addon was preinstalled — that was true of the author's
machine, not this one. Install it yourself via the steps above.)

### 2. Wire the MCP client

**Claude Code** (user scope):

```bash
claude mcp add blender -s user \
  -e UV_PYTHON_PREFERENCE=only-managed \
  -e DISABLE_TELEMETRY=true \
  -- /opt/homebrew/bin/uvx --python 3.11 blender-mcp
```

**Cursor** — global `~/.cursor/mcp.json` (or project `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "blender": {
      "command": "/opt/homebrew/bin/uvx",
      "args": ["--python", "3.11", "blender-mcp"],
      "env": {
        "UV_PYTHON_PREFERENCE": "only-managed",
        "DISABLE_TELEMETRY": "true",
        "BLENDER_HOST": "localhost",
        "BLENDER_PORT": "9876"
      }
    }
  }
}
```

**Claude Desktop** — same `mcpServers.blender` block in  
`~/Library/Application Support/Claude/claude_desktop_config.json`.

Then **fully quit and relaunch** the client (Cmd-Q). Confirm with `claude mcp list` → `blender` connected.

Optional env: `BLENDER_HOST`, `BLENDER_PORT` (default `9876`).

### 3. Connect inside Blender (every session)

1. Open Blender **with GUI** (addon server will not run in `blender -b`)
2. 3D Viewport → press **N** → **BlenderMCP** tab
3. Optional: enable Poly Haven / other integrations
4. Click **Connect to Claude** (starts the socket server)
5. In the agent chat, Blender MCP tools should appear (hammer / MCP tools)

If tools fail: Connect in Blender first, then retry the agent. Do not start a second `uvx blender-mcp` in a terminal.

## How to use (agent)

Once connected, ask in natural language. Typical tool surface:

- Inspect scene / objects
- Create, move, delete meshes
- Materials / colors
- Viewport screenshots for visual check
- `execute_blender_code` — arbitrary `bpy` (powerful; **save the .blend first**)
- Poly Haven / Sketchfab / Hyper3D / Hunyuan3D when enabled + keyed

### Example asks

- "Create a low-poly dungeon with a dragon and a pot of gold"
- "Make a studio-lit product shot of this mesh; point an isometric camera"
- "Download a concrete HDRI from Poly Haven and light the scene"
- "Export this object as GLB to `assets/models/hero.glb` for Godot/ThreeJS"

### Gauntlet posture

- Blender MCP is for **making the game look better** (real meshes, lighting refs, exports into ThreeJS/Godot/…)
- Prefer image gen for flat sprites/textures — see [ASSETS.md](ASSETS.md)
- Do **not** turn Blender into another harness workstream (no endless capture scoreboards)
- Export into the game project; prove the asset in a **playable in-game frame**
- One Blender GUI session + one MCP client at a time

### Credentials (optional)

In Blender: **Edit → Preferences → Add-ons → Blender MCP** — Sketchfab / Hyper3D / Hunyuan keys.  
Or env: `BLENDERMCP_SKETCHFAB_API_KEY`, `BLENDERMCP_HYPER3D_API_KEY`, etc. (see upstream README).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `spawn uvx ENOENT` | Use absolute `/opt/homebrew/bin/uvx`; relaunch client |
| Connection refused to Blender | Open Blender GUI → BlenderMCP → **Connect to Claude** |
| Works once then dies | Restart Blender connect + client MCP; only one MCP instance |
| Python / conda fights | Keep `--python 3.11` + `UV_PYTHON_PREFERENCE=only-managed`; `uv cache clean blender-mcp` |
| Timeout on huge asks | Split into smaller steps |
| Background Blender | Addon refuses `-b`; use GUI (or a virtual display) |

Upstream: [github.com/ahujasid/blender-mcp](https://github.com/ahujasid/blender-mcp) · [blendermcp.org](https://blendermcp.org/)
