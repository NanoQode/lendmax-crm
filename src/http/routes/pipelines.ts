/**
 * Pipelines and stages, for the admin panel. The rules are in
 * services/pipelines.ts, which the v1 API calls too.
 */
import { Router } from 'express';
import { z } from 'zod';
import { can } from '../../domain/permissions.ts';
import { STAGE_CATEGORIES } from '../../domain/pipelines.ts';
import { PURPOSES } from '../../domain/required-documents.ts';
import { pool } from '../../db/pool.ts';
import {
  createPipeline, createStage, deletePipeline, deleteStage, getPipeline, moveStage, pipelineCatalogue,
  pipelineOptions, pipelineUsage, stageUsage, suggestStageMap, updatePipeline, updateStage,
} from '../../services/pipelines.ts';
import { asyncRoute } from '../middleware/errors.ts';
import { actorOf, requirePermission } from '../middleware/auth.ts';

export const pipelineRoutes: Router = Router();

const view = requirePermission('pipeline.view');
const configure = requirePermission('pipeline.configure');

pipelineRoutes.get('/pipelines', view, asyncRoute(async (req, res) => {
  res.json({
    ok: true,
    pipelines: await pipelineCatalogue(pool, req.user!.organization_id),
    categories: STAGE_CATEGORIES,
    purposes: PURPOSES,
    can_manage: can(req.user!, 'pipeline.configure'),
  });
}));

pipelineRoutes.get('/pipelines/options', view, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await pipelineOptions(req.user!.organization_id)) });
}));

pipelineRoutes.get('/pipelines/:id', view, asyncRoute(async (req, res) => {
  res.json({ ok: true, pipeline: await getPipeline(req.user!.organization_id, String(req.params.id)) });
}));

pipelineRoutes.get('/pipelines/:id/usage', view, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await pipelineUsage(req.user!.organization_id, String(req.params.id))) });
}));

pipelineRoutes.get('/pipelines/:id/suggest-map', configure, asyncRoute(async (req, res) => {
  const { target } = z.object({ target: z.string().uuid() }).parse(req.query);
  res.json({ ok: true, stage_map: await suggestStageMap(req.user!.organization_id, String(req.params.id), target) });
}));

pipelineRoutes.post('/pipelines', configure, asyncRoute(async (req, res) => {
  res.status(201).json({ ok: true, ...(await createPipeline(actorOf(req), req.body)) });
}));

pipelineRoutes.patch('/pipelines/:id', configure, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await updatePipeline(actorOf(req), String(req.params.id), req.body)) });
}));

pipelineRoutes.delete('/pipelines/:id', configure, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await deletePipeline(actorOf(req), String(req.params.id), req.body)) });
}));

pipelineRoutes.post('/pipelines/:id/stages', configure, asyncRoute(async (req, res) => {
  res.status(201).json({ ok: true, stage: await createStage(actorOf(req), String(req.params.id), req.body) });
}));

pipelineRoutes.get('/pipeline-stages/:id/usage', view, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await stageUsage(req.user!.organization_id, String(req.params.id))) });
}));

pipelineRoutes.patch('/pipeline-stages/:id', configure, asyncRoute(async (req, res) => {
  res.json({ ok: true, stage: await updateStage(actorOf(req), String(req.params.id), req.body) });
}));

pipelineRoutes.post('/pipeline-stages/:id/move', configure, asyncRoute(async (req, res) => {
  await moveStage(actorOf(req), String(req.params.id), req.body);
  res.json({ ok: true });
}));

pipelineRoutes.delete('/pipeline-stages/:id', configure, asyncRoute(async (req, res) => {
  res.json({ ok: true, ...(await deleteStage(actorOf(req), String(req.params.id), req.body)) });
}));
