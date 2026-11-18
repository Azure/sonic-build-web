const endpoint = "https://sonic-elastictest-prod-scheduler-backend-webapp.azurewebsites.net/v1/task-plans/github-app";
const scope = "api://sonic-testbed-tools-prod/.default";
const pbiId = "40516754";

const usage = `Usage: node test_merge_risk_assessment.js [--managed-identity] --submit

Requires Node.js 18+; Azure CLI is not required.

On Azure App Service, run from the application container:
  node test_merge_risk_assessment.js --managed-identity --submit
Set ADO_MI_CLIENT_ID to the client ID of the managed identity attached to that app
or slot, using the same setting as the wrapper. No development tenant/client
variables or browser sign-in are needed in this mode.

Otherwise, set ENTRA_TENANT_ID and ENTRA_DEV_CLIENT_ID to your Entra tenant and an
authorized public-client application with device-code authentication enabled.
Do not use the managed identity client ID for interactive development sign-in.
The application and your user must have delegated access to the scheduler API.

--submit            Create a REAL assessment task (browser sign-in by default).
--managed-identity  Authenticate as the attached Azure managed identity instead.
--help              Show this help without signing in or sending a request.

The task uses PBI ${pbiId} and omits model. Repeated runs create separate tasks.`;

async function main(args = process.argv.slice(2), env = process.env) {
    if (!args.length || (args.length === 1 && args[0] === "--help")) {
        console.log(usage);
        return;
    }
    const managedIdentity = args.includes("--managed-identity");
    if (!args.includes("--submit") || args.length !== (managedIdentity ? 2 : 1)) {
        throw new Error("Unsupported arguments. Run with --help or --submit.");
    }
    const clientId = (env.ADO_MI_CLIENT_ID || "").trim();
    if (managedIdentity && !clientId) {
        throw new Error("Set ADO_MI_CLIENT_ID to the attached managed identity client ID first. Run with --help for details.");
    }
    if (!managedIdentity && (!env.ENTRA_TENANT_ID || !env.ENTRA_DEV_CLIENT_ID)) {
        throw new Error("Set ENTRA_TENANT_ID and ENTRA_DEV_CLIENT_ID first. Run with --help for details.");
    }
    if (typeof fetch !== "function" || typeof AbortSignal === "undefined" ||
        typeof AbortSignal.timeout !== "function") {
        throw new Error("This terminal script requires Node.js 18 or newer.");
    }

    const body = {
        type: "MERGE_RISK_ASSESSMENT",
        pbi_id: pbiId,
        description: `Terminal smoke test: assess merge risk for the PR documented in PBI ${pbiId}.`,
    };
    console.log(`WARNING: This will create a real task at ${endpoint}`);
    console.log(JSON.stringify(body, null, 2));
    const { DeviceCodeCredential, ManagedIdentityCredential } = require("@azure/identity");
    const credential = managedIdentity
        ? new ManagedIdentityCredential({ clientId })
        : new DeviceCodeCredential({
            tenantId: env.ENTRA_TENANT_ID,
            clientId: env.ENTRA_DEV_CLIENT_ID,
            userPromptCallback: info => console.error(info.message),
        });
    const token = await credential.getToken(scope);
    if (!token || !token.token) {
        throw new Error("Authentication returned no access token; no request was sent.");
    }
    console.log("Authentication succeeded. Submitting task...");
    let response;
    let responseBody;
    try {
        response = await fetch(endpoint, {
            method: "POST",
            redirect: "manual",
            headers: {
                Authorization: `Bearer ${token.token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(60000),
        });
        responseBody = await response.text();
    } catch (error) {
        throw new Error(`Request did not complete: ${error.message}. Submission status may be unknown; check the scheduler before retrying.`);
    }
    console.log(`HTTP ${response.status}`);
    console.log(responseBody || "(empty response body)");
    if (!response.ok) {
        throw new Error(`Scheduler returned HTTP ${response.status}; inspect the response above.`);
    }
    console.log("Task submission succeeded. This does not mean the assessment has finished.");
}

if (require.main === module) {
    main().catch(error => {
        console.error(`Merge risk API test failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = Object.freeze({ main });
