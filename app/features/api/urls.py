from stario import Route

API_RUNS = Route("GET /api/v1/runs")
API_RUNS_CREATE = Route("POST /api/v1/runs")
API_CANCEL = Route("POST /api/v1/runs/{run_id}/cancel")
API_PROJECTS = Route("GET /api/v1/projects")
