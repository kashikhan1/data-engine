type FilterLike = {
    id?: string;
    dimension?: string;
    label?: string;
    type?: string;
    value?: any;
    options?: Array<{ label: string; value: any }>;
};

const defaultDateOptions = [
    { label: "Today", value: "today" },
    { label: "This Week", value: "this_week" },
    { label: "This Month", value: "this_month" },
    { label: "Last 7 Days", value: "last_7_days" },
    { label: "Last 30 Days", value: "last_30_days" },
    { label: "Custom", value: "custom" }
];

const uniqueOptions = (options: Array<{ label: string; value: any }>) => {
    const seen = new Set<string>();
    const out: Array<{ label: string; value: any }> = [];
    options.forEach((opt) => {
        const key = JSON.stringify(opt?.value);
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({
            label: String(opt?.label ?? opt?.value ?? ""),
            value: opt?.value
        });
    });
    return out;
};

const inferOptionsFromValue = (value: any) => {
    if (!Array.isArray(value)) return [];
    return uniqueOptions(
        value.map((entry) => ({
            label: String(entry),
            value: entry
        }))
    );
};

export const normalizeFilterSet = (filters: FilterLike[] = []) => {
    return (filters || [])
        .filter((filter) => filter && typeof filter === "object")
        .map((filter, index) => {
            const dimension = String(filter.dimension || "").trim();
            const id = String(filter.id || dimension || `filter_${index + 1}`);
            const label = String(filter.label || dimension || `Filter ${index + 1}`);
            const lowerType = String(filter.type || "select").toLowerCase();
            const options = uniqueOptions(
                Array.isArray(filter.options)
                    ? filter.options
                    : inferOptionsFromValue(filter.value)
            );

            if (lowerType === "date-range" || lowerType === "date_range") {
                const value = filter.value ?? "last_30_days";
                return {
                    id,
                    dimension: dimension || id,
                    label,
                    type: "date-range",
                    value,
                    options: options.length > 0 ? options : defaultDateOptions
                };
            }

            if (lowerType === "multi-select" || lowerType === "multi_select") {
                const value = Array.isArray(filter.value) ? filter.value : [];
                return {
                    id,
                    dimension: dimension || id,
                    label,
                    type: "multi-select",
                    value,
                    options
                };
            }

            if (lowerType === "search") {
                const value = typeof filter.value === "string" ? filter.value : "";
                return {
                    id,
                    dimension: dimension || id,
                    label,
                    type: "search",
                    value,
                    options: []
                };
            }

            return {
                id,
                dimension: dimension || id,
                label,
                type: "select",
                value: filter.value ?? null,
                options
            };
        });
};
