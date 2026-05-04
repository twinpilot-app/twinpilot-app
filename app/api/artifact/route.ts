import { NextRequest, NextResponse } from "next/server";
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, normalize, resolve } from "path";
import { createClient } from "@supabase/supabase-js";
import { load as parseYaml } from "js-yaml";
import { TP_BUCKET, localSprintPath, isWithinBase } from "@/lib/paths";

function buildRawUrl(repoUrl: string, branch: string, path: string): string {
  const gh = repoUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${branch}/${path}`;
  const gl = repoUrl.match(/^https?:\/\/gitlab\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  if (gl) return `https://gitlab.com/${gl[1]}/-/raw/${branch}/${path}`;
  return `${repoUrl.replace(/\/$/, "")}/${branch}/${path}`;
}

function serviceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );
}

/**
 * Fetch an artifact from Supabase Storage.
 * Called when the artifact is not present on the local filesystem — this is
 * the case for all CLI-agent artifacts, which are written directly to Storage
 * (the Trigger.dev worker filesystem is ephemeral and not shared with command-center).
 *
 * ref format: "{projectSlug}/sprint-{N}/{scaffoldDir}/{filename}"
 * Storage path (TwinPilotBucket): "TwinPilotProjects/{tenantSlug}/{factorySlug}/{projectSlug}/staging/sprint-{N}/{file}"
 */
async function fetchArtifactFromStorage(bucketPath: string): Promise<string | null> {
  try {
    const sb = serviceClient();

    const { data } = await sb.storage
      .from(TP_BUCKET)
      .download(bucketPath);
    if (data) return await data.text();

    return null;
  } catch {
    return null;
  }
}

// ─── YAML spec → markdown ─────────────────────────────────

interface YamlSpec {
  slug?: string;
  name?: string;
  version?: string;
  squad?: string;
  autonomy?: string;
  level?: string | null;
  origin?: string;
  persona?: string;
  sipoc?: {
    suppliers?: { from: string; artifact: string; optional?: boolean }[];
    inputs?: { artifact: string; id?: string; criteria?: string; optional?: boolean }[];
    outputs?: { artifact: string; id?: string; format?: string; quality?: string }[];
    customers?: { to: string; receives: string }[];
  };
  protocol?: {
    human_gate?: boolean;
    human_gate_reason?: string;
    autonomy_desc?: string;
    sla?: string;
  };
  tools?: string[];
  integrations?: { name: string; purpose: string; status: string }[];
  constraints?: string;
}

function yamlSpecToMarkdown(spec: YamlSpec): string {
  const L: string[] = [];
  const name = spec.name ?? spec.slug ?? "Unknown Agent";

  L.push(`# ${name} Agent Contract`, "");

  const meta = [
    spec.squad && `Squad: ${spec.squad}`,
    spec.autonomy && `Autonomy: ${spec.autonomy.toUpperCase()}`,
    spec.version && `v${spec.version}`,
    spec.origin && `Origin: ${spec.origin}`,
  ].filter(Boolean).join(" · ");
  if (meta) L.push(`> ${meta}`, "");

  if (spec.persona?.trim()) {
    L.push("## Role", "", spec.persona.trim(), "");
  }

  const sipoc = spec.sipoc;
  if (sipoc) {
    L.push("## SIPOC", "");

    if (sipoc.suppliers?.length) {
      L.push("### Supplier");
      sipoc.suppliers.forEach((s) => {
        const opt = s.optional ? " _(optional)_" : "";
        L.push(`- **${s.from}** → ${s.artifact}${opt}`);
      });
      L.push("");
    }

    if (sipoc.inputs?.length) {
      L.push("### Input");
      L.push("| Artifact | ID | Criteria | Optional |");
      L.push("|----------|----|----------|----------|");
      sipoc.inputs.forEach((i) => {
        L.push(`| ${i.artifact} | ${i.id ?? "—"} | ${i.criteria ?? "—"} | ${i.optional ? "Yes" : "No"} |`);
      });
      L.push("");
    }

    if (spec.protocol) {
      const p = spec.protocol;
      L.push("### Process");
      L.push(`**Human gate:** ${p.human_gate ? "Yes" : "No"}${p.human_gate_reason ? ` — ${p.human_gate_reason}` : ""}`);
      if (p.autonomy_desc) L.push(`**Autonomy:** ${p.autonomy_desc}`);
      if (p.sla) L.push(`**SLA:** ${p.sla}`);
      L.push("");
    }

    if (sipoc.outputs?.length) {
      L.push("### Output");
      L.push("| Artifact | ID | Format | Quality |");
      L.push("|----------|----|--------|---------|");
      sipoc.outputs.forEach((o) => {
        L.push(`| ${o.artifact} | ${o.id ?? "—"} | ${o.format ?? "—"} | ${o.quality ?? "—"} |`);
      });
      L.push("");
    }

    if (sipoc.customers?.length) {
      L.push("### Customer");
      sipoc.customers.forEach((c) => L.push(`- **${c.to}** → ${c.receives}`));
      L.push("");
    }
  }

  if (spec.tools?.length) {
    L.push("## Tools");
    L.push("| Tool | Status |");
    L.push("|------|--------|");
    spec.tools.forEach((t) => L.push(`| \`${t}\` | native |`));
    if (spec.integrations?.length) {
      spec.integrations.forEach((i) => L.push(`| ${i.name} | ${i.status} — ${i.purpose} |`));
    }
    L.push("");
  }

  if (spec.constraints?.trim()) {
    L.push("## Constraints", "", spec.constraints.trim(), "");
  }

  return L.join("\n");
}

/**
 * GET /api/artifact?ref=scout/OPP-SIMPLE-TODO-001.md
 *   Serves staging artifact content from the factory's .staging/ directory.
 *
 * GET /api/artifact?type=contract&agent=scout
 *   Serves the agent's SIPOC contract.
 *   Priority: {agent}.yaml (new structured) → {agent}.md (legacy) → DB (custom agents)
 */
export async function GET(req: NextRequest) {
  const factoryRoot = resolve(process.cwd(), "..", "..");

  // ── Contract mode ────────────────────────────────────────
  const type = req.nextUrl.searchParams.get("type");
  if (type === "contract") {
    const agent = req.nextUrl.searchParams.get("agent");
    if (!agent || !/^[a-z0-9-]+$/.test(agent)) {
      return NextResponse.json({ error: "Invalid agent name" }, { status: 400 });
    }

    // ── Path 1: YAML spec (built-in, structured) ──────────
    const yamlPath = join(factoryRoot, "agents", "contracts", `${agent}.yaml`);
    if (existsSync(yamlPath)) {
      try {
        const raw = readFileSync(yamlPath, "utf-8");
        const spec = parseYaml(raw) as YamlSpec;
        const markdown = yamlSpecToMarkdown(spec);
        return new NextResponse(markdown, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
      } catch {
        return NextResponse.json({ error: "Failed to parse YAML spec" }, { status: 500 });
      }
    }

    // ── Path 2: Legacy .md contract (built-in, old format) ─
    const contractPath = join(factoryRoot, "agents", "contracts", `${agent}.md`);
    if (existsSync(contractPath)) {
      try {
        const content = readFileSync(contractPath, "utf-8");
        return new NextResponse(content, {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
        });
      } catch {
        return NextResponse.json({ error: "Failed to read contract" }, { status: 500 });
      }
    }

    // ── Path 3: Custom agent in DB ────────────────────────
    const sb = serviceClient();
    // Scoped query — require tenantId param to prevent cross-tenant leak
    const tenantId = req.nextUrl.searchParams.get("tenantId");
    const agentQuery = sb
      .from("agent_definitions")
      .select("name, spec, metadata")
      .eq("slug", agent);
    if (tenantId) agentQuery.eq("tenant_id", tenantId);
    const { data: agentDef } = await agentQuery.maybeSingle();

    if (agentDef) {
      const meta = (agentDef.metadata as Record<string, unknown> | null) ?? {};
      const spec = (agentDef.spec as Record<string, unknown> | null) ?? {};

      // Check for legacy SIPOC contract in metadata
      if (meta.contract) {
        if (meta.contract) {
          return new NextResponse(String(meta.contract), {
            headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
          });
        }
        if (meta.repo_url) {
          const branch = String(meta.repo_branch ?? "main");
          const path   = String(meta.repo_path ?? `contracts/${agent}.md`);
          const rawUrl = buildRawUrl(String(meta.repo_url), branch, path);
          try {
            const res = await fetch(rawUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            return new NextResponse(text, {
              headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
            });
          } catch (err) {
            return NextResponse.json({ error: `Failed to fetch contract from repo: ${(err as Error).message}` }, { status: 502 });
          }
        }
        const content = `# ${agentDef.name as string} (custom agent)\n\n_SIPOC contract not yet configured. Open Studio → Agents → Edit to add a contract._`;
        return new NextResponse(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }

      // Freestyle agent
      const instructions = meta.instructions as string | undefined;
      const tools = Array.isArray(meta.tools) ? (meta.tools as string[]) : [];
      const toolLines = tools.length ? tools.map((t) => `- \`${t}\``).join("\n") : "_Universal tools only (read\\_artifact, list\\_artifacts, escalate\\_to\\_human)_";
      const content = [
        `# ${agentDef.name as string} (custom agent)`,
        "",
        "✦ **Freestyle** — no SIPOC contract. Operates based on its instructions.",
        "",
        instructions
          ? `## Instructions\n\n${instructions}`
          : "_No instructions defined for this agent. Edit it in Studio → Agents to add instructions._",
        "",
        `## Tools\n\n${toolLines}`,
      ].join("\n");
      return new NextResponse(content, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
      });
    }

    return NextResponse.json({ error: "Contract not found" }, { status: 404 });
  }

  // ── Staging artifact mode ────────────────────────────────
  const ref = req.nextUrl.searchParams.get("ref");
  if (!ref) {
    return NextResponse.json({ error: "Missing ?ref= parameter" }, { status: 400 });
  }

  // ref formats:
  //   New: "TwinPilotProjects/{tenant}/{factory}/{project}/staging/sprint-{N}/{file}"
  //   Old: "{projectSlug}/{scaffoldDir}/{filename}"
  const parts = ref.split("/");
  const isNewFormat = parts[0] === "TwinPilotProjects" && parts.length >= 7;

  let projectSlug: string;
  let tenantSlug: string | undefined;
  let factorySlug: string | undefined;

  if (isNewFormat) {
    tenantSlug  = parts[1];
    factorySlug = parts[2];
    projectSlug = parts[3]!;
  } else {
    projectSlug = parts[0]!;
  }

  const sprintNumParam = req.nextUrl.searchParams.get("sprintNum");

  // ── Try user's local filesystem (for local-mode sprints) ─
  if (projectSlug) {
    const sb = serviceClient();
    const { data: proj } = await sb
      .from("projects")
      .select("settings, factory_id")
      .eq("slug", projectSlug)
      .single();

    if (proj) {
      if (!tenantSlug || !factorySlug) {
        const { data: fac } = await sb.from("factories").select("tenant_id, slug").eq("id", proj.factory_id).single();
        factorySlug = factorySlug ?? fac?.slug as string | undefined;
        const tenantId = fac?.tenant_id as string | undefined;
        if (tenantId && !tenantSlug) {
          const { data: tenant } = await sb.from("tenants").select("slug").eq("id", tenantId).single();
          tenantSlug = tenant?.slug as string | undefined;
        }
      }

      const projCli = ((proj.settings as Record<string, unknown> | null)?.cli_agents ?? {}) as Record<string, unknown>;
      let localBase = projCli.local_base_path as string | undefined;

      // Fallback to tenant storage integration
      if (!localBase) {
        const { data: fac2 } = await sb.from("factories").select("tenant_id").eq("id", proj.factory_id).single();
        if (fac2?.tenant_id) {
          const { data: storageInts } = await sb
            .from("tenant_integrations")
            .select("secret_value")
            .eq("tenant_id", fac2.tenant_id)
            .eq("service_id", "storage");
          for (const row of storageInts ?? []) {
            try {
              const cfg = JSON.parse(row.secret_value as string) as { type?: string; basePath?: string };
              if (cfg.type === "local" && cfg.basePath) { localBase = cfg.basePath; break; }
            } catch { /* ignore */ }
          }
        }
      }

      if (localBase && tenantSlug && factorySlug) {
        const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" };

        // New format: ref is the full relative path under basePath
        if (isNewFormat) {
          const f = join(localBase, ref);
          if (isWithinBase(resolve(f), localBase) && existsSync(f)) {
            return new NextResponse(readFileSync(f, "utf-8"), { headers });
          }
        }

        // Old format: relPath is everything after projectSlug/
        const relPath = isNewFormat ? ref : ref.slice(projectSlug.length + 1);

        // 1. Explicit sprintNum param
        if (!isNewFormat && sprintNumParam) {
          const sprintDir = localSprintPath(localBase, tenantSlug, factorySlug, projectSlug, parseInt(sprintNumParam, 10));
          const f = join(sprintDir, relPath);
          if (isWithinBase(resolve(f), localBase) && existsSync(f)) {
            return new NextResponse(readFileSync(f, "utf-8"), { headers });
          }
        }

        // 2. Try direct under staging root
        const stagingRoot = join(localBase, "TwinPilotProjects", tenantSlug, factorySlug, projectSlug, "staging");
        if (!isNewFormat) {
          const directFile = join(stagingRoot, relPath);
          if (isWithinBase(resolve(directFile), localBase) && existsSync(directFile)) {
            return new NextResponse(readFileSync(directFile, "utf-8"), { headers });
          }
        }

        // 3. Scan sprint dirs (newest first) for the relPath
        if (existsSync(stagingRoot)) {
          const dirs = readdirSync(stagingRoot)
            .filter(d => d.startsWith("sprint-"))
            .sort((a, b) => {
              const na = parseInt(a.split("-")[1] ?? "0", 10);
              const nb = parseInt(b.split("-")[1] ?? "0", 10);
              return nb - na;
            });
          for (const dir of dirs) {
            const f = join(stagingRoot, dir, relPath);
            if (isWithinBase(resolve(f), localBase) && existsSync(f)) {
              return new NextResponse(readFileSync(f, "utf-8"), { headers });
            }
          }
        }
      }

      // ── Try Supabase bucket ─────────────────────────────────
      if (tenantSlug && factorySlug) {
        // New format: ref IS the bucket path
        if (isNewFormat) {
          const storageContent = await fetchArtifactFromStorage(ref);
          if (storageContent !== null) {
            return new NextResponse(storageContent, {
              headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
            });
          }
        }

        const sprintMatch = ref.match(/sprint-(\d+)/);
        const oldRelPath = ref.slice(projectSlug.length + 1);
        if (!isNewFormat && sprintMatch) {
          const bucketPath = `TwinPilotProjects/${tenantSlug}/${factorySlug}/${projectSlug}/staging/${oldRelPath}`;
          const storageContent = await fetchArtifactFromStorage(bucketPath);
          if (storageContent !== null) {
            return new NextResponse(storageContent, {
              headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
            });
          }
        } else if (!isNewFormat && sprintNumParam) {
          const bucketPath = `TwinPilotProjects/${tenantSlug}/${factorySlug}/${projectSlug}/staging/sprint-${sprintNumParam}/${oldRelPath}`;
          const storageContent = await fetchArtifactFromStorage(bucketPath);
          if (storageContent !== null) {
            return new NextResponse(storageContent, {
              headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
            });
          }
        }
      }
    }
  }

  // ── Try factory .staging/ dir (legacy, development) ─────
  const stagingRoot = join(factoryRoot, ".staging");
  const requested = normalize(join(stagingRoot, ref));
  if (requested.startsWith(stagingRoot) && existsSync(requested)) {
    try {
      const content = readFileSync(requested, "utf-8");
      return new NextResponse(content, {
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache" },
      });
    } catch {
      return NextResponse.json({ error: "Failed to read artifact" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Artifact not found" }, { status: 404 });
}
