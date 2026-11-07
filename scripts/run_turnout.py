"""Keep generated layouts in the chatbot workspace, without modifying Turnout."""
from pathlib import Path
from turnout import server

server.OUTPUT = Path.cwd() / "layouts"
server.PREVIEWS = Path.cwd() / "previews"
server.run()
