"""`python -m keystone_worklog` – same as the `keystone-worklog` command."""
from .app import main

if __name__ == "__main__":  # guarded: worker processes (document reading) re-import this module on Windows
    main()
