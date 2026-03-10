mod dep_graph;
mod test_coverage;
mod blame_context;
mod shuffle;

use std::env;
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: dr-context <subcommand> [args...]");
        eprintln!("Subcommands: dep-graph, test-coverage, blame-context, shuffle");
        return ExitCode::from(1);
    }

    let result = match args[1].as_str() {
        "dep-graph" => {
            if args.len() != 5 {
                eprintln!("Usage: dr-context dep-graph <project_root> <changed_files_newline_sep> <output_path>");
                return ExitCode::from(1);
            }
            dep_graph::run(&args[2], &args[3], &args[4])
        }
        "test-coverage" => {
            if args.len() != 5 {
                eprintln!("Usage: dr-context test-coverage <project_root> <changed_files_newline_sep> <output_path>");
                return ExitCode::from(1);
            }
            test_coverage::run(&args[2], &args[3], &args[4])
        }
        "blame-context" => {
            if args.len() != 5 {
                eprintln!("Usage: dr-context blame-context <project_root> <material_file> <output_path>");
                return ExitCode::from(1);
            }
            blame_context::run(&args[2], &args[3], &args[4])
        }
        "shuffle" => {
            if args.len() != 5 {
                eprintln!("Usage: dr-context shuffle <material_file> <session_dir> <num_workers>");
                return ExitCode::from(1);
            }
            shuffle::run(&args[2], &args[3], &args[4])
        }
        _ => {
            eprintln!("Unknown subcommand: {}", args[1]);
            Err("unknown subcommand".into())
        }
    };

    match result {
        Ok(msg) => {
            println!("{}", msg);
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("Error: {}", e);
            ExitCode::from(1)
        }
    }
}
