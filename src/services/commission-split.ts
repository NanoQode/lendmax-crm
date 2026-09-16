/**
 * What the staff member on a file makes of its commission, and what the
 * brokerage keeps.
 *
 * One brokerage-wide percentage, set by the admin under Settings and read
 * wherever a commission is divided: the Funding tab shows it, and confirming a
 * funding starts its splits from it. It is a dated setting like the others, so
 * a change applies from the day it is made and the split that was in force
 * before stays readable. A commission already confirmed keeps the percentages
 * it was recorded with — changing the policy never rewrites what was paid.
 *
 * Only the admin sees it. It is behind `commission.view` / `commission.edit`,
 * which no staff role holds by default.
 */
import type pg from 'pg';
import { pool } from '../db/pool.ts';

export const COMMISSION_SPLIT_KEY = 'commission_split';

export type CommissionSplit = {
  staff_percent: number;
  brokerage_percent: number;
  effective_from: string | null;
  updated_by_name: string | null;
  is_default: boolean;
};

export const DEFAULT_STAFF_PERCENT = 50;

export async function getCommissionSplit(
  organizationId: string,
  client: Pick<pg.PoolClient, 'query'> = pool,
): Promise<CommissionSplit> {
  const { rows } = await client.query<{
    value: { staff_percent?: unknown }; effective_from: string; updated_by_name: string | null;
  }>(
    `SELECT s.value, to_char(s.effective_from, 'YYYY-MM-DD') AS effective_from, u.name AS updated_by_name
       FROM settings s LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.organization_id = $1 AND s.key = $2 AND s.effective_from <= CURRENT_DATE
      ORDER BY s.effective_from DESC LIMIT 1`,
    [organizationId, COMMISSION_SPLIT_KEY]);
  const stored = Number(rows[0]?.value?.staff_percent);
  const staff = Number.isFinite(stored) && stored >= 0 && stored <= 100 ? stored : DEFAULT_STAFF_PERCENT;
  return {
    staff_percent: staff,
    brokerage_percent: round2(100 - staff),
    effective_from: rows[0]?.effective_from ?? null,
    updated_by_name: rows[0]?.updated_by_name ?? null,
    is_default: !rows[0],
  };
}

/** Takes effect today; an earlier value is kept, and a second change today replaces today's. */
export async function setCommissionSplit(
  organizationId: string, userId: string, staffPercent: number,
  client: Pick<pg.PoolClient, 'query'> = pool,
): Promise<void> {
  const staff = round2(staffPercent);
  await client.query(
    `INSERT INTO settings (organization_id, key, value, effective_from, updated_by)
     VALUES ($1,$2,$3::jsonb,CURRENT_DATE,$4)
     ON CONFLICT (organization_id, key, effective_from)
     DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by`,
    [organizationId, COMMISSION_SPLIT_KEY,
     JSON.stringify({ staff_percent: staff, brokerage_percent: round2(100 - staff) }), userId]);
}

const round2 = (n: number) => Math.round(n * 100) / 100;
