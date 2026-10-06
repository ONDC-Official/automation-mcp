import type { UpstreamFlow } from "@/modules/catalog/catalog.schema.js";
import type { OrderInputs } from "@/modules/batch/batch.schema.js";

/**
 * What to send for a step that declares inputs, worked out from the
 * declaration itself — so any flow runs from its `flow_id` alone, with no table
 * of which step is which.
 *
 * Fields are filled by name. The ones that describe *this order* come from the
 * generated order and the seller's own replies: the city, the two stations
 * and the quantity from the order; the item id read back from the seller's
 * catalog (never templated). Every other field takes the default the flow's own
 * schema publishes for it, which is what the workbench's own UI pre-fills.
 */

export type Step = UpstreamFlow["sequence"][number];

interface Property {
  default?: unknown;
  enum?: unknown[];
  /** An array's declared element schema, when it has one. */
  items?: { properties?: Record<string, Property> };
}

/** Every property a step's input declarations mention, with its schema. */
export function declaredProperties(step: Step): Map<string, Property> {
  const properties = new Map<string, Property>();
  for (const declaration of step.input ?? []) {
    // Live flows publish `schema`; mock-runner configs call the same thing
    // `jsonSchema`.
    const schema =
      declaration.schema ??
      (declaration as { jsonSchema?: unknown }).jsonSchema;
    const found =
      typeof schema === "object" && schema !== null
        ? (schema as { properties?: unknown }).properties
        : undefined;
    if (typeof found === "object" && found !== null) {
      for (const [name, value] of Object.entries(found)) {
        properties.set(
          name,
          typeof value === "object" && value !== null
            ? (value as Property)
            : {},
        );
      }
    }
  }
  return properties;
}

/** A step that needs an origin and a destination station. */
export function needsStations(step: Step): boolean {
  const fields = declaredProperties(step);
  return fields.has("start_code") && fields.has("end_code");
}

/** A step that picks an item, so needs a real item id from the seller. */
export function needsItem(step: Step): boolean {
  const fields = declaredProperties(step);
  return fields.has("Item_id") || fields.has("items");
}

/**
 * One element of an `items` array, shaped by the array's own declared element
 * schema. The item id goes to the field named `itemId` (or `id`), the quantity
 * to any count or quantity field, and everything else takes its published
 * default. A flow that declares no element schema keeps the older `id` shape.
 */
function buildItem(
  arrayProperty: Property,
  itemId: string,
  order: OrderInputs | undefined,
): Record<string, unknown> {
  const element = arrayProperty.items?.properties ?? {};
  const item: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(element)) {
    if (/^(itemId|id)$/i.test(field)) item[field] = itemId;
    else if (/count|quantity/i.test(field))
      item[field] = order?.item_quantity ?? spec.default ?? 1;
    else if (spec.default !== undefined) item[field] = spec.default;
  }
  if (Object.keys(item).length > 0) return item;
  return {
    id: itemId,
    quantity: { selected: { count: order?.item_quantity ?? 1 } },
  };
}

/** Inputs for one step. `itemId` is required only when {@link needsItem}. */
export function buildStepInputs(
  step: Step,
  ctx: { order?: OrderInputs; itemId?: string },
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};

  for (const [name, property] of declaredProperties(step)) {
    const order = ctx.order;
    switch (name) {
      case "city_code":
        if (order) inputs[name] = order.city_code;
        else if (property.default !== undefined)
          inputs[name] = property.default;
        continue;
      case "start_code":
        if (order) inputs[name] = order.start_code;
        continue;
      case "end_code":
        if (order) inputs[name] = order.end_code;
        continue;
      case "vehicle_category":
        // Only when the flow allows it: a mismatch with its own enum would be
        // refused by the seller.
        if (
          order &&
          (property.enum === undefined ||
            property.enum.includes(order.vehicle_category))
        ) {
          inputs[name] = order.vehicle_category;
        } else if (property.default !== undefined) {
          inputs[name] = property.default;
        }
        continue;
      case "Item_id":
        if (ctx.itemId !== undefined) inputs[name] = ctx.itemId;
        continue;
      case "Item_Quantity":
        inputs[name] = order?.item_quantity ?? property.default ?? 1;
        continue;
      case "items":
        if (ctx.itemId !== undefined) {
          inputs[name] = [buildItem(property, ctx.itemId, order)];
        }
        continue;
      default:
        if (property.default !== undefined) inputs[name] = property.default;
    }
  }

  // A step that declares input but names nothing this can fill still has to be
  // given *something*: an empty object reads as "no input" and is refused.
  // `id` is exempt from the declared schema and ignored by every generator.
  return Object.keys(inputs).length > 0 ? inputs : { id: step.key };
}
