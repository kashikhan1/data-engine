'use client';

import React from 'react';
import { useWorkflowStore, WorkflowStep } from '@/state/stores';
import { Steps, ConfigProvider, theme } from 'antd';
import {
    DatabaseOutlined,
    BulbOutlined,
    CodeOutlined,
    PlayCircleOutlined,
    LayoutOutlined
} from '@ant-design/icons';

const workflowSteps = [
    { title: 'Schema', icon: <DatabaseOutlined /> },
    { title: 'Plan', icon: <BulbOutlined /> },
    { title: 'SQL', icon: <CodeOutlined /> },
    { title: 'Execute', icon: <PlayCircleOutlined /> },
    { title: 'Dashboard', icon: <LayoutOutlined /> }
];

export const WorkflowStepper: React.FC = () => {
    const { currentStep, setStep, staleStep } = useWorkflowStore();

    return (
        <div style={{ padding: '12px 24px', background: 'rgba(0,0,0,0.2)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <Steps
                current={currentStep - 1}
                onChange={(s) => setStep((s + 1) as WorkflowStep)}
                size="small"
                items={workflowSteps.map((s, idx) => ({
                    ...s,
                    status: (staleStep !== null && idx + 1 >= staleStep) ? 'error' : undefined,
                    disabled: idx + 1 > currentStep && staleStep === null
                }))}
            />
        </div>
    );
};
