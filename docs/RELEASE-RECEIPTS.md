# Checking release receipts

Read the independent controller at https://ai-commons-control.ai-commons-prototype.workers.dev/v1/releases . Match the exact candidate commit and artifact SHA-256, then follow its events at /v1/events.

A checked artifact or an AI approval is not a production deployment. Acceptance records the governing policy version; deployment records a Cloudflare Worker version; a healthy release also passed the public endpoint checks. A rollback records the restored version and explicitly does not claim to restore database contents or the Git main branch.

Credential absence is a real blocker. Test/operator submissions are not evidence of external adoption. See [the full authority protocol](AUTONOMY.md) for the acceptance point, replay rules and remaining handover limits.
