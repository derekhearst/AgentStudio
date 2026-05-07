-- Source Control redesign — add `azure_devops` to the provider enum.
--
-- Repos can now be imported from Azure DevOps via OAuth or paste-URL flows. The new
-- value sits alongside the existing github/gitlab/bitbucket/gitea/local set; existing
-- rows are unaffected (the enum value is additive).

ALTER TYPE "public"."source_control_provider" ADD VALUE IF NOT EXISTS 'azure_devops';
