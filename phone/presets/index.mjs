// Auto-generated index of verified 2026 GMP HVAC Smoke Validation presets.
import area1 from './GMP_SMOKE_AREA1_2026R1.mjs';
import area2 from './GMP_SMOKE_AREA2_2026R1.mjs';
import area3 from './GMP_SMOKE_AREA3_2026R1.mjs';
import postUf from './GMP_SMOKE_POST_UF_2026R1.mjs';
import globUf from './GMP_SMOKE_GLOB_UF_2026R1.mjs';
import thaw from './GMP_SMOKE_THAW_2026R1.mjs';
import cd from './GMP_SMOKE_CD_2026R1.mjs';

export const BUILTIN_PRESETS = Object.freeze([area1, area2, area3, postUf, globUf, thaw]);

export const BUILTIN_PRESETS_BY_ID = Object.freeze(
  Object.fromEntries([area1, area2, area3, postUf, globUf, thaw, cd].map(preset => [preset.template_id, preset]))
);

export function getBuiltinPreset(templateId) {
  const key = String(templateId ?? '').trim();
  const found = BUILTIN_PRESETS_BY_ID[key] ?? null;
  return found ? JSON.parse(JSON.stringify(found)) : null;
}
