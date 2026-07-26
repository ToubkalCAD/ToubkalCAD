# Security Policy

## Supported versions

ToubkalCAD is in active pre-release development. Security fixes are applied to
the latest revision of the `main` branch.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Use GitHub's **Security** tab and select **Report a vulnerability** to create a
private security advisory for the maintainers. Include:

- Affected commit or version
- Reproduction steps or a proof of concept
- Expected impact
- Any suggested mitigation

Please allow the maintainers reasonable time to investigate before disclosing
the issue publicly. A maintainer will acknowledge the report through the
private advisory and coordinate remediation and disclosure there.

## Scope

Security reports may include:

- Malicious or malformed CAD/project files
- Browser-side code execution or data exposure
- Unsafe handling of imported STEP or IGES data
- Dependency or build-pipeline compromise
- Cross-origin isolation or deployment-header weaknesses

Ordinary bugs and feature requests should use the public issue tracker.
