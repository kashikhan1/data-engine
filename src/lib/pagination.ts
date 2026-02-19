export interface NormalizedPaginationConfig {
    page: number;
    pageSize: number;
    offset: number;
    includeTotal: boolean;
}

export const PAGINATION_DEFAULT_PAGE = 0;
export const PAGINATION_DEFAULT_PAGE_SIZE = 25;
export const PAGINATION_MAX_PAGE_SIZE = 100;

const toFiniteNumber = (value: any): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const clampPage = (value: number | null) => {
    if (value === null || value < 0) return PAGINATION_DEFAULT_PAGE;
    return Math.floor(value);
};

const clampPageSize = (value: number | null) => {
    if (value === null || value <= 0) return PAGINATION_DEFAULT_PAGE_SIZE;
    return Math.min(PAGINATION_MAX_PAGE_SIZE, Math.floor(value));
};

const clampOffset = (value: number | null, page: number, pageSize: number) => {
    if (value === null || value < 0) return page * pageSize;
    return Math.floor(value);
};

const readNumeric = (params: Record<string, any>, keys: string[]) => {
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
        const value = toFiniteNumber(params[key]);
        if (value !== null) return value;
    }
    return null;
};

const inferPaginationIds = (params: Record<string, any>) => {
    const ids = new Set<string>();
    Object.keys(params || {}).forEach((key) => {
        const match = String(key).match(/^__(?:page|pageSize|offset):(.+)$/);
        const id = match?.[1]?.trim();
        if (id) ids.add(id);
    });
    return ids;
};

export const toRecordFromFilterMap = (filters: Map<string, any> | Record<string, any> | undefined) => {
    if (!filters) return {};
    if (filters instanceof Map) return Object.fromEntries(filters);
    return { ...filters };
};

export const normalizePaginationConfig = (input: {
    page: number | null;
    pageSize: number | null;
    offset: number | null;
    includeTotal?: boolean;
}): NormalizedPaginationConfig => {
    const page = clampPage(input.page);
    const pageSize = clampPageSize(input.pageSize);
    const offset = clampOffset(input.offset, page, pageSize);
    return {
        page,
        pageSize,
        offset,
        includeTotal: input.includeTotal !== false
    };
};

export const getPaginationForId = (
    params: Record<string, any>,
    id: string,
    options?: { includeTotal?: boolean; allowGlobalFallback?: boolean }
): NormalizedPaginationConfig => {
    const includeTotal = options?.includeTotal !== false;
    const allowGlobal = options?.allowGlobalFallback !== false;

    const page = readNumeric(params, [`__page:${id}`, `storePage:${id}`, `page:${id}`])
        ?? (allowGlobal ? readNumeric(params, ["storePage", "page"]) : null);
    const pageSize = readNumeric(params, [
        `__pageSize:${id}`,
        `storeSize:${id}`,
        `rowsOnPage:${id}`,
        `size:${id}`,
        `pageSize:${id}`,
        `page_size:${id}`
    ]) ?? (allowGlobal ? readNumeric(params, ["storeSize", "rowsOnPage", "size", "pageSize", "page_size"]) : null);
    const offset = readNumeric(params, [`__offset:${id}`, `offset:${id}`])
        ?? (allowGlobal ? readNumeric(params, ["offset"]) : null);

    return normalizePaginationConfig({ page, pageSize, offset, includeTotal });
};

export const buildTablePaginationMap = (
    params: Record<string, any>,
    candidateWidgets: any[] = [],
    options?: { includeTotal?: boolean; allowGlobalFallback?: boolean }
) => {
    const widgetById = new Map<string, any>();
    (candidateWidgets || []).forEach((widget: any) => {
        if (!widget || typeof widget?.id !== "string") return;
        if (String(widget?.type || "").toLowerCase() !== "table") return;
        if (!widgetById.has(widget.id)) {
            widgetById.set(widget.id, widget);
        }
    });

    inferPaginationIds(params).forEach((id) => {
        if (!widgetById.has(id)) {
            widgetById.set(id, { id, type: "table" });
        }
    });

    const tablePagination: Record<string, NormalizedPaginationConfig> = {};
    Array.from(widgetById.values()).forEach((widget: any) => {
        const config = getPaginationForId(params, widget.id, options);
        tablePagination[widget.id] = config;
        if (typeof widget?.queryId === "string" && widget.queryId.trim()) {
            tablePagination[widget.queryId] = config;
        }
    });
    return tablePagination;
};
