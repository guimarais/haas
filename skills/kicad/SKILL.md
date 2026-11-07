---
name: kicad
description: Create or edit native KiCad schematics and PCB boards, place components, route tracks, check designs and export fabrication files using Konnect MCP.
---

1. Establish the circuit requirements, interfaces, power, board constraints and desired deliverables. Ask for missing design decisions before creating a circuit.
2. Use Konnect MCP exclusively for KiCad operations. Call list_toolboxes, then load_toolset for the needed capabilities. Use tool_search to discover newly loaded tools; Konnect changes its tool list dynamically.
3. Read get_effective_config with the workspace project_dir for applicable preferences. Work on explicit paths in the workspace. Imported designs are copies. Create native projects using create_project; preserve reference designators and internal project references when editing or renaming.
4. Inspect the design before editing. Use targeted schematic and PCB tools. Live PCB operations require KiCad 10 with IPC enabled and the workspace board open. Use an explicit board path on each board tool; if IPC is unavailable or the open board differs, explain the required user action and stop board mutations. The unscoped save_project tool is disabled. Save and verify live edits through run_drc with sync_live_board=true and an explicit board path; if that targeted operation is unavailable, ask the user to save the workspace board in KiCad.
5. Run ERC for schematics and DRC for boards when applicable, inspect results, and resolve issues within scope. After live PCB edits use the persisted, synchronised board for DRC. Report unresolved findings and any checks that could not run.
6. Return native file links and available previews/check results. Export manufacturing files only when requested, and describe remaining review work.

Complete when requested native artifacts exist and requested checks have results, or when a specific missing requirement or KiCad readiness issue is clearly reported.
