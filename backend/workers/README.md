# Background workers

`src/job-policy.js` provides explicit job transitions and capped exponential backoff. A production queue still needs durable claims/leases, deduplication, dead-letter tooling and observability.
