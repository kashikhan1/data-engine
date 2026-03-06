export function categorizeDataType(dataType: string): string {
    const lowerType = String(dataType || "").toLowerCase();

    if (
        lowerType.includes("int")
        || lowerType.includes("numeric")
        || lowerType.includes("decimal")
        || lowerType.includes("float")
        || lowerType.includes("double")
        || lowerType.includes("real")
    ) {
        return "numeric";
    }

    if (
        lowerType.includes("char")
        || lowerType.includes("text")
        || lowerType.includes("varchar")
        || lowerType.includes("string")
    ) {
        return "text";
    }

    if (
        lowerType.includes("date")
        || lowerType.includes("time")
        || lowerType.includes("timestamp")
        || lowerType.includes("interval")
    ) {
        return "temporal";
    }

    if (lowerType.includes("bool") || lowerType.includes("boolean")) {
        return "boolean";
    }

    if (lowerType.includes("json") || lowerType.includes("array")) {
        return "complex";
    }

    return "other";
}

export function isNumericType(dataType: string): boolean {
    return categorizeDataType(dataType) === "numeric";
}

export function isTemporalType(dataType: string): boolean {
    return categorizeDataType(dataType) === "temporal";
}

export function isTextType(dataType: string): boolean {
    return categorizeDataType(dataType) === "text";
}

export function getColumnName(column: { name?: string; column_name?: string } | null | undefined): string {
    return column?.name || column?.column_name || "";
}
