import React from 'react';
import { CheckCircleOutlined, CloseCircleOutlined, LoadingOutlined, SyncOutlined } from '@ant-design/icons';
import { Space, Typography, Progress as AntProgress } from 'antd';
import styles from './ProgressTracker.module.css';

const { Text } = Typography;

export type StageStatus = 'pending' | 'in_progress' | 'completed' | 'error';

export interface ProgressStage {
  id: string;
  label: string;
  status: StageStatus;
  message?: string;
  progress?: number;
}

interface ProgressTrackerProps {
  stages: ProgressStage[];
  title?: string;
  currentStageId?: string;
  showOverallProgress?: boolean;
}

export const ProgressTracker: React.FC<ProgressTrackerProps> = ({
  stages,
  title = 'Processing',
  currentStageId,
  showOverallProgress = true,
}) => {
  const completedCount = stages.filter(s => s.status === 'completed').length;
  const inProgressCount = stages.filter(s => s.status === 'in_progress').length;
  const errorCount = stages.filter(s => s.status === 'error').length;
  const overallProgress = Math.round((completedCount / stages.length) * 100);
  
  const getStatusIcon = (status: StageStatus) => {
    switch (status) {
      case 'completed':
        return <CheckCircleOutlined className={styles.iconCompleted} />;
      case 'in_progress':
        return <LoadingOutlined spin className={styles.iconInProgress} />;
      case 'error':
        return <CloseCircleOutlined className={styles.iconError} />;
      default:
        return <div className={styles.iconPending} />;
    }
  };

  return (
    <div className={styles.container}>
      {title && (
        <div className={styles.header}>
          <SyncOutlined spin className={styles.headerIcon} />
          <Text className={styles.title}>{title}</Text>
          {inProgressCount > 0 && (
            <span className={styles.stageCount}>
              {completedCount + 1} of {stages.length}
            </span>
          )}
        </div>
      )}
      
      {showOverallProgress && (
        <AntProgress 
          percent={overallProgress} 
          showInfo={false}
          strokeColor={{
            '0%': '#6366f1',
            '100%': '#10b981',
          }}
          trailColor="rgba(99, 102, 241, 0.2)"
          className={styles.overallProgress}
        />
      )}
      
      <div className={styles.stages}>
        {stages.map((stage, index) => (
          <div 
            key={stage.id} 
            className={`${styles.stage} ${stage.status === 'in_progress' ? styles.stageActive : ''} ${stage.status === 'error' ? styles.stageError : ''} ${stage.status === 'completed' ? styles.stageCompleted : ''}`}
          >
            <div className={styles.stageIndicator}>
              {getStatusIcon(stage.status)}
              {index < stages.length - 1 && <div className={styles.stageConnector} />}
            </div>
            <div className={styles.stageContent}>
              <Text className={`${styles.stageLabel} ${stage.status === 'in_progress' ? styles.labelActive : ''}`}>
                {stage.label}
              </Text>
              {stage.message && (
                <Text className={styles.stageMessage}>{stage.message}</Text>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

interface CompactProgressProps {
  status: 'idle' | 'running' | 'completed' | 'error';
  message?: string;
  progress?: number;
}

export const CompactProgress: React.FC<CompactProgressProps> = ({
  status,
  message,
  progress,
}) => {
  const getStatusConfig = () => {
    switch (status) {
      case 'running':
        return { color: '#6366f1', icon: <LoadingOutlined spin />, text: message || 'Processing...' };
      case 'completed':
        return { color: '#10b981', icon: <CheckCircleOutlined />, text: message || 'Complete' };
      case 'error':
        return { color: '#ef4444', icon: <CloseCircleOutlined />, text: message || 'Error' };
      default:
        return { color: '#6b7280', icon: null, text: '' };
    }
  };

  const config = getStatusConfig();

  return (
    <div className={styles.compactContainer}>
      {status === 'running' && progress !== undefined && (
        <AntProgress 
          percent={progress} 
          size="small"
          strokeColor={config.color}
          trailColor="rgba(99, 102, 241, 0.2)"
          className={styles.compactProgress}
        />
      )}
      <div className={styles.compactContent}>
        <span style={{ color: config.color }}>{config.icon}</span>
        <Text className={styles.compactText} style={{ color: config.color }}>
          {config.text}
        </Text>
      </div>
    </div>
  );
};

export default ProgressTracker;
