"""TBC AI Tools — deploy submodules.

Split out of the now-too-large `deploy_projects_ext.py` (~1630 lines) so the
two largest concerns — GitHub-backed code review and the SSE autopilot loop —
can be edited and tested in isolation.

Imported for side-effects at the end of `deploy_projects_ext.setup_routers()`:
each module hangs its endpoints off the shared `ops_router` / `projects_router`
defined in the parent module.
"""
