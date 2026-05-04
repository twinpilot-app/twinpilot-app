# Branding

Kit de marca do command-center. Suporta múltiplas marcas a partir do mesmo código (white-label build-time). `BRAND_ID` determina qual marca é montada no deploy.

```
branding/
├── packs/            assets visuais por marca (logos, cores, tipografia, ícones, web)
│   ├── tirsa/        vendor de tirsasoftware/branding
│   └── twinpilot/    vendor de twinpilot-app/branding
├── configs/          adapter por marca: strings UI, URLs, CLI, refs de asset
│   ├── tirsa.json
│   └── twinpilot.json
└── README.md
```

## Como funciona

1. `scripts/brand-prebuild.mjs` lê `BRAND_ID` (default `twinpilot`).
2. Copia `packs/<id>/*` → `public/brand/*` (Next serve em `/brand/…`).
3. Gera `lib/brand.active.ts` a partir de `configs/<id>.json`.
4. `lib/brand.ts` reexporta como `{ brand }` com tipo `Brand`.
5. Qualquer componente usa `import { brand } from "@/lib/brand"`.

O prebuild roda automaticamente em `npm install`, `npm run dev` e `npm run build` via hooks do `package.json`. Pra flipar localmente pra validar a marca legado Tirsa:

```bash
BRAND_ID=tirsa npm run dev            # dev sob Tirsa
BRAND_ID=tirsa npm run build          # build prod sob Tirsa
BRAND_ID=tirsa npm run brand:prepare  # só regerar artefatos
```

Antes de commitar, volte pra twinpilot default:

```bash
npm run brand:prepare     # sem BRAND_ID, usa twinpilot
```

**Regra:** `lib/brand.active.ts` vai commitado com `BRAND_ID=twinpilot` default — TwinPilot é o produto oficial. Per-brand deploys são gerados pelo `sync-vercel.yml` matrix (veja `docs/WHITE-LABEL.md`). O guardrail CI (`scripts/check-brand-leaks.sh`) reforça essa invariante — falha se detectar `brand.active.ts` não-twinpilot.

## Adicionar uma nova marca

1. Crie `branding/packs/<id>/` com as mesmas subpastas (logos/, colors/, typography/, icons/, web/).
2. Crie `branding/configs/<id>.json` seguindo o shape de `tirsa.json` (tipo `Brand` em `lib/brand-types.ts`).
3. (Fase 7) Adicione o id à matrix do `sync-vercel.yml` e `publish-cli.yml`.
4. (Infra) Crie Vercel project + Supabase project + repo sync target. Veja `docs/WHITE-LABEL.md`.

## Sincronizar pack de origem

Os packs são *vendored* — a fonte canônica fica em:

- `github.com/tirsasoftware/branding` → `packs/tirsa/`
- `github.com/twinpilot-app/branding` → `packs/twinpilot/`

Pra atualizar depois que o designer mexer na fonte, rode:

```bash
# exemplo manual (a automação entra em fase futura se o ritmo justificar)
rsync -a --delete ../../branding-source/tirsa/{colors,logos,icons,typography,web,github} \
  services/command-center/branding/packs/tirsa/
```

## Não edite

- `lib/brand.active.ts` — gerado. Alterações são sobrescritas pelo prebuild.
- `public/brand/` — gerado. Gitignored.
