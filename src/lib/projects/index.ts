export {
	projects,
	projectKindEnum,
	type ProjectRow,
	type ProjectKind,
} from './projects.schema'
export {
	slugify,
	createProject,
	listProjects,
	getProjectById,
	getProjectBySlug,
	updateProject,
	deleteProject,
	type CreateProjectInput,
} from './projects.server'
export {
	listProjectsQuery,
	getProjectByIdQuery,
	createProjectCommand,
	updateProjectCommand,
	deleteProjectCommand,
} from './projects.remote'
