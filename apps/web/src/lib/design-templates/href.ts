/** The project's design frame templates: GET, and PUT / DELETE on `/:key`. */
export const designTemplatesApi = (projectId: string, key?: string): string =>
  `/projects/${encodeURIComponent(projectId)}/design/templates${
    key === undefined ? '' : `/${encodeURIComponent(key)}`
  }`;
