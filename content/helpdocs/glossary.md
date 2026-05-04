---
title: Glossary
icon: 📖
category: User Guides
order: 2
color: a
---

# Glossary

Key terms used throughout {{brand.name}}.

## Factory

### Tenant
The organization or company that owns the {{brand.name}} workspace.

### Factory
The operational unit within a tenant. A factory can be a Software Factory (producing code and AI pipelines) or an IoT & Industrial factory (managing devices and processes).

### Office
The active work queue. Projects added to the Office are being actively managed and can have sprints started.

### DNA
The configuration layer that defines the factory's identity: its culture, tech stack preferences, code standards, and squad structure.

## Studio

### Squad
A group of agents organized around a business domain (e.g., Frontend, Backend, QA). Squads map to the SIPOC Supplier/Customer structure.

### Agent
An AI worker with a specific role and set of instructions. Agents are either built-in (provided by {{brand.shortName}}) or custom (defined by you).

### Pipeline
A named orchestration template that defines how agents collaborate to complete a sprint. System pipelines range from Very Small to Very Big.

### SIPOC Matrix
A Lean/Six Sigma artifact adapted to the factory context. Maps Suppliers → Inputs → Process → Outputs → Customers for each squad and agent.

## Projects & Sprints

### Project
A unit of work with a description, tech stack, and associated settings. Projects can be in the Office queue or archived.

### Sprint
A single pipeline run triggered for a project. Each sprint invokes a sequence of agents and produces outputs (code, reports, PRs, etc.).

### Agent Run
A single execution of one agent within a sprint. Each run has inputs, outputs, and a status tracked in real time.

### Human Gate
A step in a pipeline that pauses and waits for human approval before continuing. Used for review checkpoints.

## Configuration

### Provider
An LLM provider (Anthropic, OpenAI, Google, etc.) configured with an API key. Providers supply the models that power agents.

### Storage
Where sprint artifacts are stored. Supports Supabase Storage, GitHub, and User Space (local filesystem).

### Orchestration
How pipeline tasks are executed. Local mode runs on your machine; Cloud mode runs on Trigger.dev workers.

### Wizard
An AI-powered assistant inside the Studio that helps configure agents, pipelines, and DNA using natural language.
