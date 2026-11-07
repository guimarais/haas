---
name: turnout
description: Design or extend XTrackCAD model railway layouts, inspect track geometry, select Märklin C-track parts and generate layout previews using Turnout MCP.
---

1. Establish the available dimensions in millimetres, track system and intended layout. Ask for missing constraints. Use list_parts to discover the actual supported catalogue.
2. Use Turnout MCP for layouts. Discover the current tools and catalogue rather than guessing their parameters. For the bundled Märklin C-track catalogue, build_layout constructs closed loops from straights and left-traversed curves; attach_track adds one compatible catalogue piece, including turnouts. Revision tools can remove/replace pieces, connect endpoints, and move/rotate selected track. Use only capabilities actually offered by the connected server. General optimisation and vehicle clearance validation remain outside its scope.
3. Use absolute workspace paths for supplied layouts. Inspect an existing working copy before attaching track. Generated .xtc files and SVG previews go to workspace layouts/ and previews/ through the app's launcher.
4. Inspect the result and report track quantities, board fit, closure and warnings. Keep geometry validation separate from vehicle/roadbed clearances. Link the native .xtc and preview.

Complete when native layout and preview exist with reported inspection results, or when the requested design exceeds the available tools and the unsupported part is explained precisely.
