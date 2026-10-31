<!-- One pull request = one backlog task. Every commit needs a DCO sign-off (git commit -s). -->

**Task:** T___

### 1. What changed

### 2. Files changed

### 3. Database migration

### 4. API / contract changes

<!-- zod + docs/CONTRACTS.md + OpenAPI updated together? -->

### 5. Tests (added / run, results)

<!-- pnpm verify:push: paste its plan and the result -->

### 6. Security / permission impact

### 7. Deployment impact

### 8. Remaining TODO

### 9. Open questions

---

- [ ] Every commit is signed off (DCO)
- [ ] New dependencies use an allowlisted license (docs/SPEC.md §1A) and are justified above
- [ ] New tenant tables/repositories: foreign keys to tenant tables include `organization_id`; tenant isolation test added
- [ ] UI strings have `en` and `vi`
