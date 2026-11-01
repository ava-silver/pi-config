Include a before/after table that compares old and new UI behavior. If you cannot capture screenshots, add the table for the user to complete:

```html
<table>
<tr><td>Before</td><td>After</td></tr>

<!--- Page to check, or how to get there -->
<tr><td>

</td>
<td>

</td></tr>

<!--- Next page to check, or how to get there -->
<tr><td>

</td>
<td>

</td></tr>
</table>
```

To get the branch hash for preview links, run `yarn hash --hash-only`.

- **Serverless-only:** `https://ddserverless-${HASH}.datadoghq.com/<inferred-path>`
- **Cross-team** (shared or non-Serverless code): include both `ddserverless-${HASH}` and `app-${HASH}` URLs.
- If the scope is ambiguous, ask.

Infer the path from changed files. Add feature flags as `?config_flag-name=true` URL parameters.
