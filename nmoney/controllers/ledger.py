"""将 HTTP 参数交给账本服务，并构造前端约定的响应。"""

from ..http.response import Response
from ..infrastructure.statements import parse_statement


def static_file(request, *, file, mime):
    return Response(file.read_bytes(), mime)


class LedgerController:
    def __init__(self, service):
        self.service = service

    def ping(self, request):
        return Response.json({"app": "NMoney", "database": self.service.database_file()})

    def ledger(self, request):
        query = request.query
        ledger = self.service.dashboard(query.get("start", ""), query.get("end", ""), query.get("platform", ""))
        return Response.json(ledger)

    def receipt_options(self, request):
        receipt_id = int(request.query["receipt_id"])
        return Response.json(self.service.receipt_options(receipt_id))

    def import_statement(self, request):
        statement = parse_statement(request.query.get("filename", ""), request.body)
        counts = self.service.import_statement(statement)
        return Response.json(dict(platform=statement.platform, **counts))

    def annotate(self, request):
        data = request.json()
        self.service.annotate(data["id"], data["category"], data["note"], data["rule"], data.get("include_over_cap"))
        return Response.json({"ok": True})

    def link_receipt(self, request):
        data = request.json()
        self.service.link_receipt(data["receipt_id"], data["expense_id"])
        return Response.json({"ok": True})

    def set_cap(self, request):
        self.service.set_cap(request.json()["cents"])
        return Response.json({"ok": True})

    def mark_daily(self, request):
        data = request.json()
        changed = self.service.mark_daily(data["ids"], data["choice"], data.get("pending_only", False),
                                          data.get("sync_staged", False))
        return Response.json({"changed": changed})
