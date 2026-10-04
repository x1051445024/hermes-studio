import Router from '@koa/router'
import * as ctrl from '../controllers/agent-status'

export const agentStatusRoutes = new Router()

agentStatusRoutes.get('/api/agents/availability', ctrl.availability)
agentStatusRoutes.get('/api/agents/status', ctrl.status)
