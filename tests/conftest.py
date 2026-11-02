"""Every test run keeps away from the live ComfyUI: nothing listens on this port. Without it, a test reached the real one on
8188 and left a connection open, and a later test's shutdown failed on it with "Event loop is closed"."""
import os

os.environ["COMFY_URL"] = "http://127.0.0.1:9"
