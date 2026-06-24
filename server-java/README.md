# RevTurbine Server SDK — Java

Server-side SDK for pre-evaluating RevTurbine placement decisions, entitlements,
and user context. Returns a serializable `ServerEvaluationPayload` that the
client-side SDK can hydrate via `sdk.hydrate(payload)`.

## Installation

### Gradle

```groovy
implementation 'io.revturbine:revturbine-server-sdk:0.1.0'
```

### Maven

```xml
<dependency>
  <groupId>io.revturbine</groupId>
  <artifactId>revturbine-server-sdk</artifactId>
  <version>0.1.0</version>
</dependency>
```

## Quick Start

```java
import io.revturbine.sdk.*;

RevTurbineServer server = new RevTurbineServer(
    new RevTurbineServerOptions("tenant_abc", "rt_secret_xxx", "https://api.revturbine.io")
);

// Build evaluation request
Types.EvaluationRequest req = new Types.EvaluationRequest();
req.userId = "user_123";
req.traits = Map.of("plan", "pro");
req.includeTheme = true;
req.includeTrialStatus = true;

Types.PlacementRequest slot = new Types.PlacementRequest();
slot.slotId = "hero_banner";
req.placements = List.of(slot);

req.entitlementHandles = List.of("advanced_analytics");

// Evaluate
Types.ServerEvaluationPayload payload = server.evaluate(req);

// Serialize to JSON for client-side hydration
String json = server.toJson(payload);
```

## Spring Boot Integration

```java
@RestController
public class SsrController {
    private final RevTurbineServer rt;

    public SsrController() {
        this.rt = new RevTurbineServer(
            new RevTurbineServerOptions(
                System.getenv("RT_TENANT_ID"),
                System.getenv("RT_SECRET_KEY"),
                System.getenv("RT_ENDPOINT")
            )
        );
    }

    @GetMapping("/page")
    public ModelAndView renderPage(HttpSession session) throws Exception {
        Types.EvaluationRequest req = new Types.EvaluationRequest();
        req.userId = session.getAttribute("userId").toString();
        req.includeTheme = true;

        Types.PlacementRequest slot = new Types.PlacementRequest();
        slot.slotId = "hero_banner";
        req.placements = List.of(slot);

        Types.ServerEvaluationPayload payload = rt.evaluate(req);

        ModelAndView mv = new ModelAndView("page");
        mv.addObject("rtPayload", rt.toJson(payload));
        return mv;
    }
}
```

## API Reference

### `RevTurbineServer`

| Method | Description |
|--------|-------------|
| `evaluate(EvaluationRequest)` | Full evaluation (placements + entitlements + context) |
| `checkEntitlement(userId, handle)` | Single entitlement check |
| `getTrialStatus(userId)` | Trial status for a user |
| `toJson(payload)` | Serialize payload to JSON |

### `RevTurbineServerOptions`

| Parameter | Required | Description |
|-----------|----------|-------------|
| `tenantId` | Yes | RevTurbine tenant identifier |
| `apiKey` | Yes | Server-side API key (secret) |
| `endpoint` | Yes | Base URL of the RevTurbine API Edge |
| `defaultTtlSeconds(int)` | No | Default TTL for payloads (default: 60) |
