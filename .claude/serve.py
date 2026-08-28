"""Static server for local development.

Python's http.server sends Last-Modified and no Cache-Control, so browsers
heuristically cache CSS and JS and keep serving stale copies after an edit —
which looks exactly like a change that didn't take. This sends no-store on
everything so a plain reload always gets the current file.
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 4173
    ThreadingHTTPServer(('127.0.0.1', port), NoCache).serve_forever()
