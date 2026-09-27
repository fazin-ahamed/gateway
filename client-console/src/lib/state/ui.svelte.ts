// Sidebar collapse, shared between the top-bar toggle and the sidebar.
let collapsed = $state(false);

export const ui = {
  get collapsed() {
    return collapsed;
  },
  toggle() {
    collapsed = !collapsed;
  }
};
