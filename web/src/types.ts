/** Mirrors the API's wire shapes. Kept as plain types — the server is the source of truth. */

export type Role = 'ADMIN' | 'PROJECT_MANAGER' | 'DEVELOPER';
export type TaskStatus = 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export const STATUSES: TaskStatus[] = ['TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE'];
export const PRIORITIES: Priority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  teamId: string | null;
}

export interface Client {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  clientId: string;
  createdById: string;
  createdAt: string;
  client?: Client;
  createdBy?: { id: string; name: string };
  _count?: { tasks: number };
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: Priority;
  dueDate: string | null;
  isOverdue: boolean;
  projectId: string;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
  assignee?: { id: string; name: string; email: string } | null;
  project?: { id: string; name: string };
}

export interface Activity {
  id: string;
  type: string;
  message: string;
  projectId: string;
  taskId: string | null;
  taskTitle: string | null;
  fromValue: string | null;
  toValue: string | null;
  createdAt: string;
  actor: { id: string; name: string; role: Role };
}

export interface Notification {
  id: string;
  message: string;
  link: string | null;
  isRead: boolean;
  activityId: string | null;
  createdAt: string;
}

export interface AdminDashboard {
  role: 'ADMIN';
  totalProjects: number;
  totalTasks: number;
  activeUsersOnline: number;
  overdueCount: number;
  generatedAt: string;
  tasksByStatus: Record<TaskStatus, number>;
  recentActivity: Activity[];
}

export interface PmDashboard {
  role: 'PROJECT_MANAGER';
  projects: Project[];
  tasksByPriority: Partial<Record<Priority, number>>;
  tasksByStatus: Record<TaskStatus, number>;
  upcomingDueThisWeek: Task[];
  overdueCount: number;
  generatedAt: string;
}

export interface DevDashboard {
  role: 'DEVELOPER';
  tasks: Task[];
  tasksByStatus: Record<TaskStatus, number>;
  overdueCount: number;
  generatedAt: string;
}

export type Dashboard = AdminDashboard | PmDashboard | DevDashboard;

/** The filter set the brief requires to live in the URL. */
export interface TaskFilters {
  status: string;
  priority: string;
  dueFrom: string;
  dueTo: string;
  projectId: string;
  assigneeId: string;
}
