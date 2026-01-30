"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Button, Card, Form, Input, Typography } from "antd";

const { Title, Text } = Typography;

const AUTH_STORAGE_KEY = "fake_auth_ok";

export default function FakeAuthGate({ children }: { children: React.ReactNode }) {
    const [ready, setReady] = useState(false);
    const [isAuthed, setIsAuthed] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const requiredEmail = useMemo(() => process.env.NEXT_PUBLIC_FAKE_AUTH_EMAIL || "", []);
    const requiredPassword = useMemo(() => process.env.NEXT_PUBLIC_FAKE_AUTH_PASSWORD || "", []);
    const enforceCredentials = Boolean(requiredEmail || requiredPassword);

    useEffect(() => {
        try {
            const stored = localStorage.getItem(AUTH_STORAGE_KEY);
            if (stored === "true") {
                setIsAuthed(true);
            }
        } finally {
            setReady(true);
        }
    }, []);

    const handleLogin = (values: { email: string; password: string }) => {
        setError(null);
        const email = (values.email || "").trim();
        const password = values.password || "";
        if (!email || !password) {
            setError("Email and password are required.");
            return;
        }
        if (enforceCredentials) {
            if (email !== requiredEmail || password !== requiredPassword) {
                setError("Invalid credentials.");
                return;
            }
        }
        localStorage.setItem(AUTH_STORAGE_KEY, "true");
        setIsAuthed(true);
    };

    const handleLogout = () => {
        localStorage.removeItem(AUTH_STORAGE_KEY);
        setIsAuthed(false);
    };

    if (!ready) return null;
    if (isAuthed) {
        return (
            <>
                {children}
                <div style={{ position: "fixed", bottom: 18, right: 18, zIndex: 50 }}>
                    <Button size="small" onClick={handleLogout}>
                        Sign out
                    </Button>
                </div>
            </>
        );
    }

    return (
        <div
            style={{
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "radial-gradient(circle at top, #182235 0%, #0b0d11 45%, #07090d 100%)",
                padding: 24,
            }}
        >
            <Card style={{ width: 420, borderRadius: 18 }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <Title level={3} style={{ margin: 0 }}>
                        Secure Access
                    </Title>
                    <Text type="secondary">
                        Enter your email and password to continue.
                    </Text>
                </div>
                <Form layout="vertical" style={{ marginTop: 20 }} onFinish={handleLogin}>
                    <Form.Item label="Email" name="email" rules={[{ required: true, message: "Please enter your email" }]}>
                        <Input type="email" placeholder="you@company.com" />
                    </Form.Item>
                    <Form.Item label="Password" name="password" rules={[{ required: true, message: "Please enter your password" }]}>
                        <Input.Password placeholder="••••••••" />
                    </Form.Item>
                    {error && (
                        <Text type="danger" style={{ display: "block", marginBottom: 8 }}>
                            {error}
                        </Text>
                    )}
                    <Button type="primary" htmlType="submit" block>
                        Sign in
                    </Button>
                    {enforceCredentials ? (
                        <Text type="secondary" style={{ display: "block", marginTop: 10, fontSize: 12 }}>
                            Credentials are enforced via NEXT_PUBLIC_FAKE_AUTH_EMAIL/PASSWORD.
                        </Text>
                    ) : (
                        <Text type="secondary" style={{ display: "block", marginTop: 10, fontSize: 12 }}>
                            Demo mode: any email/password works.
                        </Text>
                    )}
                </Form>
            </Card>
        </div>
    );
}
