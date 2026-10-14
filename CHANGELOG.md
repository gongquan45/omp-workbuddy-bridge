# Changelog

## [Unreleased]

## [1.0.0] - 2026-10-14

First version-controlled baseline of the existing implementation.

### Added
- Five OMP-native tools for WorkBuddy task delegation: `wb_task`, `wb_status`, `wb_cancel`, `wb_tasks`, and `wb_doctor`.
- Interactive session binding via `/wb bind` and discoverable desktop worker attachment.
- Human-in-the-loop permission approvals for file, terminal, and browser operations requested by WorkBuddy.
- Durable filesystem task store under `.wb-bridge/` with briefs, inputs, outputs, lock management, and JSON receipts.
- Packaged `workbuddy-delegate` skill and live-smoke acceptance guide.
- Git repository baseline and single-source product versioning tied to `package.json`.
