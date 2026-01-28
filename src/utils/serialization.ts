/**
 * Recursively converts Sets and Maps to arrays and objects for JSON serialization.
 * Also handles other non-serializable objects that LangChain might return.
 */
export function serializeForClient(obj: any): any {
    if (obj === null || obj === undefined) {
        return obj;
    }

    // Handle Arrays
    if (Array.isArray(obj)) {
        return obj.map(serializeForClient);
    }

    // Handle Sets
    if (obj instanceof Set) {
        return Array.from(obj).map(serializeForClient);
    }

    // Handle Maps
    if (obj instanceof Map) {
        const result: Record<string, any> = {};
        for (const [key, value] of obj.entries()) {
            result[String(key)] = serializeForClient(value);
        }
        return result;
    }

    // Handle Dates
    if (obj instanceof Date) {
        return obj.toISOString();
    }

    // Handle LangChain messages or other complex objects with a toJSON method
    if (typeof obj.toJSON === "function") {
        return serializeForClient(obj.toJSON());
    }

    // Handle plain objects
    if (typeof obj === "object") {
        const result: Record<string, any> = {};
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                result[key] = serializeForClient(obj[key]);
            }
        }
        return result;
    }

    return obj;
}
