import { createContext, useEffect, useState } from "react";
import { BrowserRouter as Router, Link, useParams } from "react-router-dom";
import { Line } from "react-chartjs-2";
// DO NOT REMOVE
// necessary to avoid "category is not a registered scale" error.
import { Chart as ChartJS } from "chart.js/auto";
import { Chart } from "react-chartjs-2";
import { format } from "date-fns";
import { AgGridReact } from "ag-grid-react"; // React Grid Logic
import "ag-grid-community/styles/ag-grid.css"; // Core CSS
import "ag-grid-community/styles/ag-theme-quartz.css"; // Theme

export const Dashboard = () => {
  const [loading, setLoading] = useState(false);
  const [testNames, setTestNames] = useState([]);

  const fetchData = async () => {
    const response = await fetch("/api/v0/results", {
      headers: {
        "Content-type": "application/json",
        Authorization: "Bearer " + localStorage.getItem("token"),
      },
    });
    const resultData = await response.json();
    resultData.map((element) => {
      const test_name = element.test_name;
      console.log(test_name);
      setTestNames((prevState) => [...prevState, test_name]);
    });
  };
  useEffect(() => {
    setLoading(true);
    fetchData().finally(() => {
      setLoading(false);
    });
  }, []);

  return (
    <>
      {loading ? (
        <div>Loading</div>
      ) : (
        <div className="container">
          <div className="card">
            <div className="card-header">Please select a test</div>
            <div className="card-body">
              <ul className="list-group list-group-flush">
                {testNames.map((name, i) => {
                  return (
                    <li className="list-group-item">
                      <Link
                        to={`/result/${name}`}
                        testName={name}
                        state={{ testName: name }}
                      >
                        {name}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const parseTimestamp = (t) => {
  const utcSeconds = t;
  var d = new Date(0);
  d.setUTCSeconds(utcSeconds);
  return format(d, "yyyy-MM-dd HH:mm");
};

const formatCommit = (commit, commit_msg) => {
  // Limit the git commit sha to 12 characters to improve readability
  return commit.substring(0, 12) + ' ("' + commit_msg + '")';
};

const ChangePointSummaryTable = ({ changeData }) => {
  var rowData = [];

  Object.entries(changeData).forEach(([testName, value]) => {
    value.forEach((changePoint) => {
      console.log(changePoint);
      const changes = changePoint["changes"];
      console.log(changes);
      changes.map((change) => {
        const commit = changePoint["attributes"]["git_commit"][0];

        let commit_msg = "";
        if (changePoint["attributes"].hasOwnProperty("commit_msg")) {
          commit_msg = changePoint["attributes"]["commit_msg"][0];
        }

        const repo = changePoint["attributes"]["git_repo"][0];
        rowData.push({
          date: parseTimestamp(changePoint["time"]),
          commit: { commit, commit_msg, repo },
          metric: change["metric"],
          change: change["forward_change_percent"] + "%",
        });
      });
    });
  });

  const colDefs = [
    { field: "date" },
    { field: "metric" },
    { field: "change" },
    {
      field: "commit",
      cellRenderer: (params) => {
        const { commit, commit_msg, repo } = params.value;

        // If we failed to lookup the commit message, display the commit sha
        if (commit_msg === "") {
          return commit;
        }

        const url = repo + "/commit/" + commit;
        const text = formatCommit(commit, commit_msg);
        return (
          <a href={url} target="_blank">
            {text}
          </a>
        );
      },
    },
  ];

  return (
    <>
      <div className="ag-theme-quartz" style={{ height: 500, width: 900 }}>
        <AgGridReact rowData={rowData} columnDefs={colDefs} pagination={true} />
      </div>
    </>
  );
};

export const SingleResult = () => {
  const { testName } = useParams();
  const [loading, setLoading] = useState(false);
  const [displayData, setDisplayData] = useState([]);
  const [changePointData, setChangePointData] = useState([]);
  const fetchData = async () => {
    const results = await fetch("/api/v0/result/" + testName, {
      headers: {
        "Content-type": "application/json",
        Authorization: "Bearer " + localStorage.getItem("token"),
      },
    });
    const resultData = await results.json();
    resultData.sort((a, b) => {
      return a.timestamp - b.timestamp;
    });
    setDisplayData(resultData);

    const changes = await fetch("/api/v0/result/" + testName + "/changes", {
      headers: {
        "Content-type": "application/json",
        Authorization: "Bearer " + localStorage.getItem("token"),
      },
    });
    const changeData = await changes.json();
    setChangePointData(changeData);
  };

  const parseData = (data, metricName) => {
    console.log(data);
    const value_map = data.map(
      (result) =>
        result.metrics
          .filter((metric) => metric.name === metricName)
          .map((metric) => metric.value)[0]
    );
    console.log(value_map);
    return value_map;
  };

  useEffect(() => {
    setLoading(true);
    fetchData().finally(() => {
      setLoading(false);
    });
  }, []);

  console.log("Display data");
  console.log(displayData);

  const timestamps = displayData.map((result) => {
    return result.timestamp;
  });

  var metricMap = [];
  displayData.map((result) => {
    result.metrics.map((metric) => {
      metricMap.push({ name: metric.name, unit: metric.unit });
    });
  });

  // Only want unique metric names
  var unique = metricMap.reduce((a, b) => {
    if (a.findIndex((x) => x.name === b.name) === -1) {
      return a.concat([b]);
    } else {
      return a;
    }
  }, []);
  console.log("unique: " + unique);

  // {'testName':
  //    [{
  //      'time': 123,
  //      'changes': [{'forward_change_percent': 900, 'metric': 'metric1'}]
  //    }]
  // }
  const changePointTimes = [];

  // TODO(mfleming) Assumes a single testName but must handle multiple
  // tests in the future.
  Object.entries(changePointData).forEach(([testName, value]) => {
    value.forEach((changePoint) => {
      const metrics = changePoint["changes"].map((change) => {
        return change["metric"];
      });
      console.log(metrics);
      const t = changePoint["time"];
      changePointTimes.push({ t, metrics });
    });
  });

  var changePointIndexes = [];
  timestamps.map((timestamp, index) => {
    changePointTimes.map((change) => {
      const { t, metrics } = change;
      if (t !== timestamp) {
        return;
      }
      changePointIndexes.push({ index, metrics });
    });
  });

  const drawLineChart = (metric) => {
    const metricName = metric["name"];
    const metricUnit = metric["unit"];
    return (
      <>
        <h6 className="text-center">
          {testName}: {metricName}
        </h6>
        <Line
          datasetIdKey="foo"
          data={{
            labels: timestamps.map(parseTimestamp),
            datasets: [
              {
                id: 1,
                label: metricName,
                data: parseData(displayData, metricName),
                pointRadius: (context) => {
                  const c = changePointIndexes;
                  const entry = changePointIndexes.find((element) => {
                    return (
                      element.metrics.includes(metricName) &&
                      element.index === context.dataIndex
                    );
                  });
                  return entry ? 8 : 0;
                },
              },
            ],
          }}
          options={{
            scales: {
              x: {
                grid: {
                  display: false,
                },
              },
            },
            plugins: {
              legend: {
                display: false,
              },
              interaction: {
                intersect: false,
                mode: "index",
              },
              tooltip: {
                displayColors: false,
                callbacks: {
                  label: (context) => {
                    var labelArray = ["value: " + context.raw + metricUnit];

                    // Search in changePointData for this timestamp and metric
                    const timestamp = timestamps[context.dataIndex];
                    Object.entries(changePointData).forEach(
                      ([testName, value]) => {
                        value.forEach((changePoint) => {
                          if (changePoint["time"] === timestamp) {
                            labelArray.push("");

                            // Add all change point attributes to the label
                            changePoint["changes"].forEach((change) => {
                              if (change["metric"] !== metricName) {
                                return;
                              }

                              Object.entries(change).map(([key, value]) => {
                                if (key === "metric") {
                                  return;
                                }

                                var label = key + ": " + value;
                                if (key.includes("percent")) {
                                  label = label + "%";
                                }

                                labelArray.push(label);
                              });
                            });
                          }
                        });
                      }
                    );

                    return labelArray;
                  },
                },
                intersect: false,
              },
            },
          }}
        />
      </>
    );
  };

  return (
    <>
      {loading ? (
        <div>Loading</div>
      ) : (
        <>
          <nav className="navbar navbar-expand-lg">
            <div className="container-fluid">
              <nav aria-label="breadcrumb">
                <ol className="breadcrumb">
                  <li className="breadcrumb-item">
                    <Link to="/">Tests</Link>
                  </li>
                  <li className="breadcrumb-item active" aria-current="page">
                    {testName}
                  </li>
                </ol>
              </nav>
            </div>
          </nav>
          <div className="container">
            <div className="row justify-content-center">
              <ChangePointSummaryTable changeData={changePointData} />
            </div>
            <div className="row">{unique.map(drawLineChart)}</div>
          </div>
        </>
      )}
    </>
  );
};
