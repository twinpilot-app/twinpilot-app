---
title: Repositories
icon: 📂
category: User Guides
order: 6
color: c
parent: prerequisites
---

# 📂 Repositories (Optional)

Connect a Git repository to push sprint outputs as branches or pull requests.

---

## 🐙 GitHub

### What you need
- A **GitHub Personal Access Token** with `repo` scope
- Your **GitHub username or organization** name

### Setup
1. Go to [github.com/settings/tokens](https://github.com/settings/tokens)
2. Create a **Fine-grained** or **Classic** token with `repo` scope
3. In {{brand.name}}, go to **Storage**
4. Under **GitHub**, enter:
   - **Token** — your personal access token
   - **Owner** — your username or org (e.g., `mycompany`)
5. Click **Save** then **Test**

### How it works
- When a sprint completes, agents can push output to a GitHub repo
- Creates a branch `sprint/{sprintNum}` with all project files
- Optionally opens a Pull Request

---

## 🦊 GitLab

> 🔜 **Coming soon** — GitLab integration is planned for a future release.
