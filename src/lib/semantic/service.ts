export interface Metric {
    slug: string;
    name: string;
    description: string;
    sql_definition: string;
    agg_type: string;
}

export interface Dimension {
    slug: string;
    name: string;
    type: string;
    sql_definition: string;
    table_name: string;
}

class SemanticService {
    async getMetrics(): Promise<Metric[]> {
        // In production, this would query semantic.metrics
        // Mocking for now
        return [
            {
                slug: "weekly_retention",
                name: "Weekly Retention",
                description: "Percentage of users who returned after 7 days",
                sql_definition: "count(distinct user_id) filter (where returned = true) * 1.0 / count(distinct user_id)",
                agg_type: "ratio",
            },
            {
                slug: "active_users",
                name: "Active Users",
                description: "Number of unique users with at least one event",
                sql_definition: "count(distinct user_id)",
                agg_type: "count",
            }
        ];
    }

    async getDimensions(): Promise<Dimension[]> {
        return [
            {
                slug: "country",
                name: "Country",
                type: "string",
                sql_definition: "user_attributes.country",
                table_name: "user_attributes",
            },
            {
                slug: "signup_date",
                name: "Signup Date",
                type: "date",
                sql_definition: "users.created_at",
                table_name: "users",
            }
        ];
    }

    async resolveMapping(terms: string[]): Promise<{ metrics: Metric[], dimensions: Dimension[] }> {
        const allMetrics = await this.getMetrics();
        const allDims = await this.getDimensions();

        // Smart fuzzy matching for terms
        const matchedMetrics = allMetrics.filter(m =>
            terms.some(t =>
                m.name.toLowerCase().includes(t.toLowerCase()) ||
                m.slug.toLowerCase().includes(t.toLowerCase()) ||
                t.toLowerCase().includes(m.slug.toLowerCase())
            )
        );

        const matchedDims = allDims.filter(d =>
            terms.some(t =>
                d.name.toLowerCase().includes(t.toLowerCase()) ||
                d.slug.toLowerCase().includes(t.toLowerCase()) ||
                t.toLowerCase().includes(d.slug.toLowerCase())
            )
        );

        return { metrics: matchedMetrics, dimensions: matchedDims };
    }

    async resolveJoinPath(tables: string[]): Promise<string[]> {
        // In production, this would query semantic.joins
        // Mocking a simple join registry
        const joinRegistry = [
            { t1: "users", t2: "orders", on: "users.id = orders.user_id" },
            { t1: "users", t2: "user_attributes", on: "users.id = user_attributes.user_id" }
        ];

        const joins: string[] = [];
        const seen = new Set<string>();

        for (let i = 0; i < tables.length; i++) {
            for (let j = i + 1; j < tables.length; j++) {
                const t1 = tables[i];
                const t2 = tables[j];
                const join = joinRegistry.find(r =>
                    (r.t1 === t1 && r.t2 === t2) || (r.t1 === t2 && r.t2 === t1)
                );
                if (join && !seen.has(`${t1}-${t2}`)) {
                    joins.push(`JOIN ${t2} ON ${join.on}`);
                    seen.add(`${t1}-${t2}`);
                    seen.add(`${t2}-${t1}`);
                }
            }
        }
        return joins;
    }
}

export const semanticService = new SemanticService();
