import { analyzeExchange } from "./analyzer.js";
const SHARED_TOOL = {
    type: "function",
    function: {
        name: "search_orders",
        description: "Search customer orders by email address and optional delivery status.",
        parameters: {
            type: "object",
            additionalProperties: false,
            properties: {
                email: { type: "string", format: "email", description: "Customer email address." },
                status: { type: "string", enum: ["processing", "shipped", "delivered"] },
            },
            required: ["email"],
        },
    },
};
export function createDemoRuns(pricing = []) {
    const verbosePolicy = [
        "You are Acme Support, a careful customer support assistant.",
        "Always be helpful, concise, accurate, empathetic, professional, calm, and friendly.",
        "Never invent an order. Never expose private data. Never mention internal tools.",
        "Before answering, restate the customer's request and silently make a plan.",
        "When a delivery is late, apologize, report the last scan, and give the next action.",
        "Use plain English. Do not use jargon. Do not make legal or financial promises.",
    ].join("\n");
    const leanPolicy = [
        "You are Acme Support.",
        "Use tools for order facts; never invent private data.",
        "For late deliveries: apologize, report the last scan, and give the next action in plain English.",
    ].join("\n");
    const orderResult = JSON.stringify({
        order_id: "ord_demo_314",
        status: "shipped",
        carrier: "ParcelBird",
        last_scan: "Bangkok distribution center",
        expected_delivery: "2026-08-12",
        history: Array.from({ length: 18 }, (_, index) => ({
            at: `2026-08-${String(index + 1).padStart(2, "0")}T08:00:00Z`,
            event: index === 17 ? "Arrived at distribution center" : "Automated network checkpoint",
            internal_facility_code: `PB-${String(index).padStart(4, "0")}`,
        })),
    });
    const first = analyzeExchange({
        model: "gpt-5.6-terra",
        metadata: { ctxprof: { prompt_version: "support-v1", label: "Support agent · verbose" } },
        messages: [
            { role: "system", content: verbosePolicy },
            { role: "user", content: "Where is order ord_demo_314? It was supposed to arrive yesterday." },
            { role: "tool", name: "search_orders", tool_call_id: "call_demo", content: orderResult },
        ],
        tools: [
            SHARED_TOOL,
            {
                type: "function",
                function: {
                    name: "issue_refund",
                    description: "Issue a full or partial refund after explicit customer confirmation.",
                    parameters: {
                        type: "object",
                        properties: {
                            order_id: { type: "string" },
                            amount: { type: "number" },
                            reason: { type: "string" },
                        },
                        required: ["order_id", "reason"],
                    },
                },
            },
        ],
    }, {
        model: "gpt-5.6-terra",
        choices: [{ message: { role: "assistant", content: "Your order reached the Bangkok distribution center this morning and is expected tomorrow. I’m sorry for the delay." } }],
        usage: { prompt_tokens: 1_184, completion_tokens: 31, total_tokens: 1_215 },
    }, {
        source: "fixture",
        capturedAt: "2026-08-11T12:00:00.000Z",
        durationMs: 842,
        status: 200,
        pricing,
    });
    const second = analyzeExchange({
        model: "gpt-5.6-terra",
        metadata: { ctxprof: { prompt_version: "support-v2", label: "Support agent · lean" } },
        messages: [
            { role: "system", content: leanPolicy },
            { role: "user", content: "Where is order ord_demo_314? It was supposed to arrive yesterday." },
            {
                role: "tool",
                name: "search_orders",
                tool_call_id: "call_demo",
                content: JSON.stringify({
                    order_id: "ord_demo_314",
                    status: "shipped",
                    last_scan: "Bangkok distribution center",
                    expected_delivery: "2026-08-12",
                }),
            },
        ],
        tools: [SHARED_TOOL],
    }, {
        model: "gpt-5.6-terra",
        choices: [{ message: { role: "assistant", content: "Your order reached the Bangkok distribution center and is expected tomorrow. I’m sorry for the delay." } }],
        usage: { prompt_tokens: 326, completion_tokens: 26, total_tokens: 352 },
    }, {
        source: "fixture",
        capturedAt: "2026-08-11T12:04:00.000Z",
        durationMs: 611,
        status: 200,
        pricing,
    });
    return [first, second];
}
//# sourceMappingURL=demo.js.map